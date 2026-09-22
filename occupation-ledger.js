/*
 * 占用账本（occupation-ledger.js）
 * 负责：线材批次余量、领料占位/释放、阴干位顺序、刷新后对账。
 * 纯数据操作，不访问 DOM，也不做返修规则判定（是否允许领料由返修判定层决定）。
 */
(function (global) {
  "use strict";

  const OPEN_ORDER_STATUS = ["accepted", "repairing", "review"];

  function uid(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return prefix + "-" + global.crypto.randomUUID().slice(0, 8);
    }
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function stamp() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }

  function batchOf(store, batchId) {
    return store.batches.find(b => b.id === batchId);
  }

  /* 余量 = 总量 - 未释放占位（held 与 pendingRelease 都继续占位，复核前不还量） */
  function recomputeRemaining(store) {
    store.batches.forEach(b => {
      const used = store.occupations
        .filter(o => o.batchId === b.id && o.status !== "released")
        .reduce((sum, o) => sum + o.qty, 0);
      b.remaining = Math.max(0, b.total - used);
    });
  }

  function addBatch(store, input) {
    const total = Math.floor(Number(input.total));
    const name = (input.name || "").trim();
    if (!name) throw new Error("请填写批次名称");
    if (!(total > 0)) throw new Error("批次总量必须大于 0");
    const batch = { id: uid("b"), name, line: input.line || "中线", total, remaining: total };
    store.batches.push(batch);
    return batch;
  }

  /* 领料：调用方需先经返修判定确认未被冻结 */
  function requisition(store, workId, batchId, qty) {
    const amount = Math.floor(Number(qty));
    if (!(amount > 0)) throw new Error("领料数量必须大于 0");
    const batch = batchOf(store, batchId);
    if (!batch) throw new Error("线材批次不存在");
    if (batch.remaining < amount) {
      throw new Error(`批次「${batch.name}」余量不足，仅剩 ${batch.remaining} 米`);
    }
    const occupation = {
      id: uid("occ"),
      workId,
      batchId,
      qty: amount,
      at: stamp(),
      status: "held", // held 占位中 / pendingRelease 待复核释放 / released 已释放
      orderId: null,
      releasedAt: ""
    };
    store.occupations.push(occupation);
    recomputeRemaining(store);
    return occupation;
  }

  /* 作品名下全部未释放占位（含待复核释放的，维持占位） */
  function occupationsForWork(store, workId) {
    return store.occupations.filter(o => o.workId === workId && o.status !== "released");
  }

  /* 进度回退时登记误占批次：只挂“待释放”，余量不返还，等复核 */
  function markPendingReleases(store, order, occupationIds) {
    occupationIds.forEach(id => {
      const occ = store.occupations.find(o => o.id === id);
      if (occ && occ.workId === order.workId && occ.status !== "released") {
        occ.status = "pendingRelease";
        occ.orderId = order.id;
      }
    });
  }

  /* 驳回 / 失效：撤销待释放标记，批次继续占位 */
  function revertPendingReleases(store, order) {
    store.occupations.forEach(o => {
      if (o.orderId === order.id && o.status === "pendingRelease") {
        o.status = "held";
        o.orderId = null;
      }
    });
  }

  /* 复核通过后唯一允许的释放入口：余量在此刻才真正返还 */
  function applyReleases(store, order) {
    store.occupations.forEach(o => {
      if (o.orderId === order.id && o.status === "pendingRelease") {
        o.status = "released";
        o.releasedAt = stamp();
      }
    });
    recomputeRemaining(store);
  }

  /* ---------- 阴干位（有顺序的工位队列） ---------- */

  function slotPosition(store, workId) {
    const i = store.slots.indexOf(workId);
    return i >= 0 ? i + 1 : null;
  }

  function enqueueSlot(store, workId) {
    if (!store.slots.includes(workId)) store.slots.push(workId); // 新入位排队尾
  }

  function removeSlot(store, workId) {
    store.slots = store.slots.filter(id => id !== workId);
  }

  /* 复核通过后执行阴干位重排：原位移到队尾，其余自动前移 */
  function requeueSlot(store, workId) {
    const i = store.slots.indexOf(workId);
    if (i >= 0) {
      store.slots.splice(i, 1);
      store.slots.push(workId);
    }
  }

  /* ---------- 刷新/加载对账：作品、批次余量、工位顺序保持一致 ---------- */

  function reconcile(store) {
    const reports = [];
    ["artisans", "works", "batches", "occupations", "reworks", "slots"].forEach(k => {
      if (!Array.isArray(store[k])) {
        store[k] = [];
        reports.push(`账本字段 ${k} 缺失，已补齐`);
      }
    });

    const workIds = new Set(store.works.map(w => w.id));
    const batchIds = new Set(store.batches.map(b => b.id));

    store.batches.forEach(b => {
      if (typeof b.total !== "number" || b.total < 0) b.total = 0;
    });

    store.occupations.forEach(o => {
      if (!["held", "pendingRelease", "released"].includes(o.status)) o.status = "held";
      if (o.status !== "released" && (!workIds.has(o.workId) || !batchIds.has(o.batchId))) {
        o.status = "released";
        o.releasedAt = o.releasedAt || stamp();
        reports.push(`悬空占位 ${o.id} 已释放`);
      }
    });

    // 待释放必须挂在一张未结束且方案包含它的返修单上，否则恢复占位（复核前不得释放）
    store.occupations.filter(o => o.status === "pendingRelease").forEach(o => {
      const order = o.orderId && store.reworks.find(r => r.id === o.orderId);
      const valid = order && OPEN_ORDER_STATUS.includes(order.status) &&
        order.plan && order.plan.releaseIds.includes(o.id);
      if (!valid) {
        o.status = "held";
        o.orderId = null;
        reports.push(`失去复核依据的待释放批次 ${o.id} 已恢复占位`);
      }
    });

    recomputeRemaining(store);

    // 工位去重、剔除不存在或已离开“待阴干”的作品，顺序保持原样
    const seen = new Set();
    const cleaned = [];
    store.slots.forEach(id => {
      const work = store.works.find(w => w.id === id);
      if (work && work.status === "待阴干" && !seen.has(id)) {
        seen.add(id);
        cleaned.push(id);
      } else if (work && work.status !== "待阴干") {
        reports.push(`作品 ${work.theme} 已离开待阴干，撤下阴干位`);
      }
    });
    store.slots = cleaned;

    return reports;
  }

  const OccupationLedger = {
    OPEN_ORDER_STATUS,
    uid,
    stamp,
    recomputeRemaining,
    addBatch,
    requisition,
    occupationsForWork,
    markPendingReleases,
    revertPendingReleases,
    applyReleases,
    slotPosition,
    enqueueSlot,
    removeSlot,
    requeueSlot,
    reconcile
  };

  global.OccupationLedger = OccupationLedger;
})(typeof window !== "undefined" ? window : globalThis);
