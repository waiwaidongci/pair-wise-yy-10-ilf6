/*
 * 返修判定（rework-judge.js）
 * 负责：返修单的受理/修复/回退/完成/复核/失效、领料冻结、职责分离、重复并发归并。
 * 只做业务判定和状态变更，不访问 DOM；线材占位与阴干位动作通过 OccupationLedger 执行。
 *
 * 核心约束：
 *  - 每件作品同时只保留一张未结束返修单（accepted/repairing/review）。
 *  - 登记断线/翘线后仅冻结新领料，已占批次维持占位。
 *  - 返修完成进入复核；复核人不能是该返修单任一缺陷的登记人。
 *  - 进度回退登记“误占批次释放 + 阴干位重排”方案，复核通过前一律不执行。
 *  - 胎体或纹样修正使未结束返修单失效；重复/并发申请沿用首次受理单。
 */
(function (global) {
  "use strict";

  const OPEN_STATUS = ["accepted", "repairing", "review"];
  const LEDGER = global.OccupationLedger;
  const DEFECT_TYPES = ["断线", "翘线"];

  function uid() { return LEDGER.uid("rw"); }
  function stamp() { return LEDGER.stamp(); }
  function shortId(order) { return order.id.replace("rw-", "R"); }

  function getWork(store, workId) {
    const work = store.works.find(w => w.id === workId);
    if (!work) throw new Error("作品不存在");
    return work;
  }

  function getOrder(store, orderId) {
    const order = store.reworks.find(r => r.id === orderId);
    if (!order) throw new Error("返修单不存在");
    return order;
  }

  function getArtisan(store, artisanId) {
    const a = store.artisans.find(x => x.id === artisanId);
    if (!a) throw new Error("请选择登记师傅");
    return a;
  }

  function openOrderOf(store, workId) {
    return store.reworks.find(r => r.workId === workId && OPEN_STATUS.includes(r.status)) || null;
  }

  function artisanName(store, id) {
    const a = store.artisans.find(x => x.id === id);
    return a ? a.name : "—";
  }

  function unresolvedDefectsOf(store, workId) {
    return (getWork(store, workId).defects || []).filter(d => !d.resolved);
  }

  /* 登记断线/翘线缺陷：仅冻结新领料，不动已占批次；可挂到现有未结束返修单上 */
  function registerDefect(store, input) {
    const work = getWork(store, input.workId);
    getArtisan(store, input.artisanId);
    const type = DEFECT_TYPES.includes(input.type) ? input.type : "";
    if (!type) throw new Error("缺陷类型必须是断线或翘线");
    const location = (input.location || "").trim();
    if (!location) throw new Error("请填写缺陷位置");

    if (!Array.isArray(work.defects)) work.defects = [];
    const defect = {
      id: LEDGER.uid("d"),
      type,
      location,
      registeredAt: stamp(),
      registrarId: input.artisanId,
      resolved: false,
      orderId: null,
      resolveNote: ""
    };
    const order = openOrderOf(store, work.id); // 已有未结束单则沿用，不另开
    if (order) {
      defect.orderId = order.id;
      order.defectIds.push(defect.id);
      order.logs.push(`${stamp()} ${artisanName(store, input.artisanId)} 补登缺陷：${type}·${location}（沿用首单 ${shortId(order)}）`);
    }
    work.defects.push(defect);
    work.logs.push(`${defect.registeredAt} 记录${type}：${location}`);
    return { defect, order };
  }

  /* 申请返修受理：有未结束单则沿用首次受理；无未结束单时必须存在已登记缺陷 */
  function openRework(store, workId, applicantId, note) {
    getWork(store, workId);
    getArtisan(store, applicantId);
    const existing = openOrderOf(store, workId);
    if (existing) {
      existing.logs.push(`${stamp()} ${artisanName(store, applicantId)} 再次申请返修，沿用首次受理 ${existing.id}`);
      return { order: existing, reused: true };
    }
    const defects = unresolvedDefectsOf(store, workId);
    if (!defects.length) {
      throw new Error("请先登记断线或翘线缺陷，再申请返修受理");
    }
    const order = {
      id: uid(),
      workId,
      applicantId,
      status: "accepted",
      createdAt: stamp(),
      defectIds: defects.map(d => d.id),
      registrarIds: [...new Set(defects.map(d => d.registrarId))],
      plan: null,
      completedAt: "",
      completerId: "",
      reviewerId: "",
      reviewedAt: "",
      reviewNote: "",
      invalidReason: "",
      logs: [`${stamp()} ${artisanName(store, applicantId)} 申请返修，首次受理（缺陷 ${defects.length} 处）`]
    };
    defects.forEach(d => { d.orderId = order.id; });
    store.reworks.push(order);
    return { order, reused: false };
  }

  /* 开始修复：受理单进入修复中 */
  function startRepair(store, orderId, artisanId) {
    const order = getOrder(store, orderId);
    getArtisan(store, artisanId);
    if (order.status !== "accepted") throw new Error("仅已受理返修单可以开始修复");
    order.status = "repairing";
    order.logs.push(`${stamp()} ${artisanName(store, artisanId)} 开始修复`);
    const work = getWork(store, order.workId);
    work.logs.push(`${stamp()} 返修单 ${shortId(order)} 开始修复`);
    return order;
  }

  /*
   * 进度回退：进度下调并登记方案（误占批次释放 + 阴干位重排）。
   * 方案只登记不执行：批次挂 pendingRelease 但仍占位，阴干位保持原位，等复核。
   */
  function rollbackProgress(store, input) {
    const order = getOrder(store, input.orderId);
    const work = getWork(store, order.workId);
    getArtisan(store, input.artisanId);
    if (order.status !== "repairing") throw new Error("仅修复中的返修单可以回退进度");
    const target = Math.floor(Number(input.newProgress));
    if (!(target >= 0) || target > 100) throw new Error("回退后进度须在 0~100 之间");
    if (target >= work.progress) throw new Error("进度回退必须小于当前进度");

    const candidate = LEDGER.occupationsForWork(store, work.id);
    (input.releaseIds || []).forEach(id => {
      const occ = candidate.find(o => o.id === id);
      // 允许 held 批次，或已挂在本单方案上的 pendingRelease 批次（重复登记沿用）；挂在别单则拒绝
      if (!occ || (occ.status === "pendingRelease" && occ.orderId !== order.id)) {
        throw new Error("所选批次不是该作品当前占用的批次");
      }
    });

    // 重复登记方案：本单旧方案未选中的待释放批次先恢复占位
    LEDGER.revertPendingReleases(store, order);
    order.plan = {
      from: work.progress,
      to: target,
      releaseIds: input.releaseIds || [],
      requeueSlot: input.requeueSlot !== false && work.status === "待阴干",
      requestedAt: stamp(),
      requestedBy: input.artisanId
    };
    LEDGER.markPendingReleases(store, order, order.plan.releaseIds);
    order.logs.push(`${stamp()} ${artisanName(store, input.artisanId)} 申请进度回退 ${work.progress}%→${target}%，待复核释放批次 ${order.plan.releaseIds.length} 个`);
    work.logs.push(`${stamp()} 返修单 ${shortId(order)} 进度申请回退至 ${target}%，等待复核`);
    return order;
  }

  /* 返修完成：修复人提交，进入复核；此时仍不释放任何占位 */
  function completeRework(store, orderId, artisanId) {
    const order = getOrder(store, orderId);
    const work = getWork(store, order.workId);
    getArtisan(store, artisanId);
    if (order.status !== "repairing") throw new Error("仅修复中的返修单可以报完成");
    order.status = "review";
    order.completedAt = stamp();
    order.completerId = artisanId;
    order.logs.push(`${stamp()} ${artisanName(store, artisanId)} 返修完成，等待复核`);
    work.logs.push(`${stamp()} 返修单 ${shortId(order)} 报完成，等待复核`);
    return order;
  }

  function resolveDefects(store, order, note) {
    const work = getWork(store, order.workId);
    (work.defects || []).forEach(d => {
      if (order.defectIds.includes(d.id) && !d.resolved) {
        d.resolved = true;
        d.resolveNote = note || "返修复核通过";
      }
    });
  }

  /*
   * 复核：approve=true 通过 / false 驳回。
   * 复核人不得是该返修单任一缺陷的登记人（未登记缺陷者复核）。
   * 通过时才执行回退方案：误占批次释放返还余量、阴干位重排、进度落定。
   */
  function reviewRework(store, input) {
    const order = getOrder(store, input.orderId);
    const work = getWork(store, order.workId);
    getArtisan(store, input.artisanId);
    if (order.status !== "review") throw new Error("仅待复核的返修单可以复核");
    if (order.registrarIds.includes(input.artisanId)) {
      throw new Error("复核人不能登记过本单缺陷，请由未登记缺陷的师傅复核");
    }
    if (input.approve) {
      const plan = order.plan;
      if (plan) {
        LEDGER.applyReleases(store, order);
        if (plan.requeueSlot) LEDGER.requeueSlot(store, work.id);
        work.progress = plan.to;
      }
      resolveDefects(store, order, input.note);
      order.status = "approved";
      order.reviewNote = (input.note || "").trim();
      order.reviewedAt = stamp();
      order.reviewerId = input.artisanId;
      order.plan = null;
      order.logs.push(`${order.reviewedAt} ${artisanName(store, input.artisanId)} 复核通过${plan ? "，已释放误占批次并重排阴干位" : ""}`);
      work.logs.push(`${order.reviewedAt} 返修单 ${shortId(order)} 复核通过`);
    } else {
      if (order.plan) LEDGER.revertPendingReleases(store, order);
      order.status = "repairing";
      order.completedAt = "";
      order.completerId = "";
      order.reviewNote = (input.note || "").trim();
      order.logs.push(`${stamp()} ${artisanName(store, input.artisanId)} 复核驳回：${input.note || "需返工"}，误占批次恢复占位`);
      work.logs.push(`${stamp()} 返修单 ${shortId(order)} 复核驳回，继续修复`);
    }
    return order;
  }

  /* 胎体或纹样修正：未结束返修单失效；未解决缺陷随单结案，领料解冻；占位列由账本规则处理 */
  function invalidateByBodyOrPattern(store, input) {
    const work = getWork(store, input.workId);
    getArtisan(store, input.artisanId);
    const reason = (input.reason || "胎体/纹样修正").trim();
    const order = openOrderOf(store, work.id);
    let bodyOrPatternChanged = false;
    if (typeof input.base === "string" && input.base.trim() && input.base !== work.base) {
      work.base = input.base.trim();
      bodyOrPatternChanged = true;
    }
    if (typeof input.theme === "string" && input.theme.trim() && input.theme !== work.theme) {
      work.theme = input.theme.trim();
      bodyOrPatternChanged = true;
    }
    if (!bodyOrPatternChanged) throw new Error("胎体材质或纹样主题至少修正一项，旧返修单才会失效");

    if (order) {
      if (order.plan) LEDGER.revertPendingReleases(store, order); // 未复核方案作废，批次维持占位
      order.status = "invalid";
      order.invalidReason = reason;
      order.logs.push(`${stamp()} ${artisanName(store, input.artisanId)} ${reason}，旧返修单失效`);
      (work.defects || []).forEach(d => {
        if (order.defectIds.includes(d.id) && !d.resolved) {
          d.resolved = true;
          d.resolveNote = `随返修单失效：${reason}`;
        }
      });
      work.logs.push(`${stamp()} ${reason}，返修单 ${shortId(order)} 失效，可重新登记缺陷申请返修`);
    }
    return order;
  }

  /* 刷新/加载归并：同一作品出现多张未结束单时，保留最早创建的，其余失效（沿用首次受理） */
  function reconcileReworks(store) {
    const reports = [];
    const groups = new Map();
    store.reworks.forEach(order => {
      if (!OPEN_STATUS.includes(order.status)) return;
      if (!Array.isArray(order.defectIds)) order.defectIds = [];
      if (!Array.isArray(order.registrarIds)) order.registrarIds = [];
      if (!Array.isArray(order.logs)) order.logs = [];
      const work = store.works.find(w => w.id === order.workId);
      if (!work) {
        if (order.plan) LEDGER.revertPendingReleases(store, order);
        order.status = "invalid";
        order.invalidReason = "作品不存在，加载对账时作废";
        reports.push(`返修单 ${order.id} 的作品已不存在，已作废`);
        return;
      }
      (work.defects || []).forEach(d => {
        if (d.orderId === order.id) {
          if (!order.defectIds.includes(d.id)) order.defectIds.push(d.id);
          if (!order.registrarIds.includes(d.registrarId)) order.registrarIds.push(d.registrarId);
        }
      });
      if (!groups.has(order.workId)) groups.set(order.workId, []);
      groups.get(order.workId).push(order);
    });

    groups.forEach(orders => {
      if (orders.length <= 1) return;
      orders.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      const first = orders[0];
      orders.slice(1).forEach(dup => {
        if (dup.plan) LEDGER.revertPendingReleases(store, dup);
        dup.status = "invalid";
        dup.invalidReason = "重复或并发申请，沿用首次受理";
        dup.logs.push(`${LEDGER.stamp()} 加载对账：与首单重复，按首次受理归并`);
        first.logs.push(`${LEDGER.stamp()} 加载对账：并入重复申请 ${dup.id}`);
        first.defectIds = [...new Set(first.defectIds.concat(dup.defectIds))];
        first.registrarIds = [...new Set(first.registrarIds.concat(dup.registrarIds))];
        const work = store.works.find(w => w.id === first.workId);
        (work.defects || []).forEach(d => {
          if (d.orderId === dup.id) d.orderId = first.id;
        });
        reports.push(`作品 ${work.theme} 存在多张未结束返修单，已沿用首次受理 ${first.id}`);
      });
    });
    return reports;
  }

  /* 是否冻结新领料：存在未解决断线/翘线缺陷即冻结（已占批次不受影响） */
  function isRequisitionBlocked(store, workId) {
    return unresolvedDefectsOf(store, workId).length > 0;
  }

  const ReworkJudge = {
    OPEN_STATUS,
    DEFECT_TYPES,
    openOrderOf,
    unresolvedDefectsOf,
    registerDefect,
    openRework,
    startRepair,
    rollbackProgress,
    completeRework,
    reviewRework,
    invalidateByBodyOrPattern,
    reconcileReworks,
    isRequisitionBlocked,
    artisanName
  };

  global.ReworkJudge = ReworkJudge;
})(typeof window !== "undefined" ? window : globalThis);
