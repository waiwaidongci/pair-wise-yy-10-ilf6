/*
 * 页面状态（page-state.js）
 * 负责：界面渲染、对话框交互、localStorage 持久化与刷新后对账编排。
 * 业务判定一律走 ReworkJudge，占库与阴干位动作一律走 OccupationLedger，本文件不内嵌规则。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "zfl42ReworkStationV1";
  const OLD_STORAGE_KEY = "zfl42Works";
  const WORK_STATUSES = ["贴线中", "待阴干", "上金粉", "待交付"];
  const REWORK_COLUMNS = [
    { key: "accepted", title: "已受理" },
    { key: "repairing", title: "修复中" },
    { key: "review", title: "待复核" }
  ];
  const REWORK_LABEL = {
    accepted: "已受理",
    repairing: "修复中",
    review: "待复核",
    approved: "复核通过",
    invalid: "已失效"
  };

  let store = null;
  let flashTimer = null;
  const dialogState = { defectWorkId: null, reqWorkId: null, editWorkId: null, rbOrderId: null };

  /* ---------------- 种子数据 ---------------- */

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function offsetDate(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
  function nowText() { return new Date().toLocaleString("zh-CN", { hour12: false }); }

  function seedStore() {
    const today = todayStr();
    const s = {
      version: 1,
      currentArtisanId: "a1",
      artisans: [
        { id: "a1", name: "林秀珍" },
        { id: "a2", name: "陈阿强" },
        { id: "a3", name: "周敏" }
      ],
      works: [],
      batches: [
        { id: "b1", name: "朱红漆线·甲批", line: "中线", total: 120, remaining: 101 },
        { id: "b2", name: "金漆线·乙批", line: "细线", total: 80, remaining: 70 },
        { id: "b3", name: "黑漆线·丙批", line: "粗线", total: 60, remaining: 60 }
      ],
      occupations: [
        { id: "occ1", workId: "w3", batchId: "b1", qty: 15, at: nowText(), status: "held", orderId: null, releasedAt: "" },
        { id: "occ2", workId: "w1", batchId: "b1", qty: 4, at: nowText(), status: "pendingRelease", orderId: "rw1", releasedAt: "" },
        { id: "occ3", workId: "w1", batchId: "b2", qty: 10, at: nowText(), status: "held", orderId: null, releasedAt: "" }
      ],
      reworks: [],
      slots: ["w1"]
    };
    s.works = [
      {
        id: "w1", base: "木胎香盒", theme: "缠枝莲", line: "细线", progress: 75,
        dryDate: today, gold: "未处理", delivery: offsetDate(6), status: "待阴干",
        note: "边线需保持低浮雕感", logs: ["创建作品", `${nowText()} 记录断线：右侧缠枝`, `${nowText()} 返修单 Rrw1 申请返修，首次受理`],
        defects: [
          { id: "d1", type: "断线", location: "右侧缠枝第二圈", registeredAt: nowText(), registrarId: "a1", resolved: false, orderId: "rw1", resolveNote: "" }
        ]
      },
      {
        id: "w2", base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95,
        dryDate: offsetDate(-2), gold: "试扫粉", delivery: offsetDate(1), status: "上金粉",
        note: "客户要求金粉偏暗", logs: ["创建作品", `${nowText()} 记录翘线：左侧枝干`, `${nowText()} 返修复核通过`],
        defects: [
          { id: "d2", type: "翘线", location: "左侧枝干", registeredAt: nowText(), registrarId: "a2", resolved: true, orderId: "rw2", resolveNote: "返修复核通过" }
        ]
      },
      {
        id: "w3", base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40,
        dryDate: offsetDate(2), gold: "未处理", delivery: offsetDate(8), status: "贴线中",
        note: "", logs: ["创建作品"], defects: []
      }
    ];
    s.reworks = [
      {
        id: "rw1", workId: "w1", applicantId: "a1", status: "repairing", createdAt: nowText(),
        defectIds: ["d1"], registrarIds: ["a1"],
        plan: { from: 75, to: 70, releaseIds: ["occ2"], requeueSlot: true, requestedAt: nowText(), requestedBy: "a1" },
        completedAt: "", completerId: "", reviewerId: "", reviewedAt: "", reviewNote: "", invalidReason: "",
        logs: [`${nowText()} 林秀珍 申请返修，首次受理（缺陷 1 处）`, `${nowText()} 林秀珍 开始修复`, `${nowText()} 林秀珍 申请进度回退 75%→70%，待复核释放批次 1 个`]
      },
      {
        id: "rw2", workId: "w2", applicantId: "a2", status: "approved", createdAt: nowText(),
        defectIds: ["d2"], registrarIds: ["a2"], plan: null,
        completedAt: nowText(), completerId: "a2", reviewerId: "a3", reviewedAt: nowText(),
        reviewNote: "翘线已压实", invalidReason: "",
        logs: [`${nowText()} 陈阿强 申请返修，首次受理（缺陷 1 处）`, `${nowText()} 周敏 复核通过`]
      }
    ];
    return s;
  }

  /* ---------------- 持久化与旧数据迁移 ---------------- */

  function migrateOldWorks(raw) {
    const s = seedStore();
    const oldWorks = Array.isArray(raw) ? raw : [];
    s.works = oldWorks.map(w => {
      const defects = [];
      if (w.defect) {
        defects.push({
          id: OccupationLedger.uid("d"),
          type: w.defect.includes("翘线") ? "翘线" : "断线",
          location: w.defect,
          registeredAt: nowText(),
          registrarId: "a1",
          resolved: false,
          orderId: null,
          resolveNote: ""
        });
      }
      return {
        id: w.id || OccupationLedger.uid("w"),
        base: w.base || "未填胎体",
        theme: w.theme || "未填纹样",
        line: w.line || "中线",
        progress: Number(w.progress) || 0,
        dryDate: w.dryDate || todayStr(),
        gold: w.gold || "未处理",
        delivery: w.delivery || offsetDate(7),
        status: WORK_STATUSES.includes(w.status) ? w.status : "贴线中",
        note: w.note || "",
        logs: Array.isArray(w.logs) ? w.logs : ["创建作品"],
        defects
      };
    });
    s.reworks = [];
    s.slots = s.works.filter(w => w.status === "待阴干").map(w => w.id);
    s.occupations = [];
    s.batches.forEach(b => { b.remaining = b.total; });
    return s;
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        store = JSON.parse(raw);
      } catch (err) {
        store = seedStore();
      }
    } else {
      const old = localStorage.getItem(OLD_STORAGE_KEY);
      if (old) {
        try {
          store = migrateOldWorks(JSON.parse(old));
        } catch (err) {
          store = seedStore();
        }
        localStorage.removeItem(OLD_STORAGE_KEY);
      } else {
        store = seedStore();
      }
    }
    // 顺序很关键：先由判定层归并/作废返修单，账本再据此核对“待释放”是否仍有复核依据
    const reports = ReworkJudge.reconcileReworks(store).concat(OccupationLedger.reconcile(store));
    persist();
    return reports;
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  /* ---------------- 小工具 ---------------- */

  const $ = sel => document.querySelector(sel);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const workById = id => store.works.find(w => w.id === id);
  const batchById = id => store.batches.find(b => b.id === id);
  const orderById = id => store.reworks.find(r => r.id === id);
  const shortOf = id => String(id || "").replace("rw-", "R");
  const nameOf = id => ReworkJudge.artisanName(store, id);

  function currentArtisanId() {
    return $("#artisanSelect").value || store.currentArtisanId;
  }
  function requireArtisan() {
    const id = currentArtisanId();
    if (!store.artisans.some(a => a.id === id)) throw new Error("请先选择当前操作师傅");
    return id;
  }

  function flash(msg, kind) {
    const bar = $("#flash");
    bar.textContent = msg;
    bar.className = "flash show " + (kind === "error" ? "error" : kind === "warn" ? "warn" : "ok");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => bar.classList.remove("show"), 2600);
  }

  function refresh(highlightOrderId) {
    persist();
    render();
    if (highlightOrderId) {
      const el = document.querySelector(`[data-ticket="${highlightOrderId}"]`);
      if (el) {
        el.classList.add("flash");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => el.classList.remove("flash"), 1800);
      }
    }
  }

  /* ---------------- 作品与工位动作 ---------------- */

  function changeWorkStatus(workId, status) {
    requireArtisan();
    const work = workById(workId);
    if (!work || work.status === status) return;
    if (status === "待阴干") {
      work.dryDate = todayStr();
      OccupationLedger.enqueueSlot(store, workId); // 进入阴干区排队尾
    }
    if (status === "上金粉") work.gold = "已上金粉";
    if (status === "待交付") work.progress = 100;
    if (work.status === "待阴干" && status !== "待阴干") {
      OccupationLedger.removeSlot(store, workId); // 离开阴干区，撤下工位
    }
    work.status = status;
    work.logs.push(`${nowText()} 更新为 ${status}`);
    refresh();
    flash(`「${work.theme}」已移至「${status}」`);
  }

  function createWork(data) {
    requireArtisan();
    const work = {
      id: OccupationLedger.uid("w"),
      base: data.base.trim(),
      theme: data.theme.trim(),
      line: data.line,
      progress: Number(data.progress),
      dryDate: data.dryDate,
      gold: data.gold,
      delivery: data.delivery,
      status: data.status,
      note: data.note.trim(),
      logs: [`${nowText()} 创建作品`],
      defects: []
    };
    store.works.unshift(work);
    if (work.status === "待阴干") OccupationLedger.enqueueSlot(store, work.id);
    refresh();
    flash(`作品「${work.theme}」已加入返修解锁台`);
  }

  function addBatch(data) {
    requireArtisan();
    OccupationLedger.addBatch(store, { name: data.batchName, line: data.batchLine, total: data.batchTotal });
    refresh();
    flash("线材批次已入账");
  }

  /* ---------------- 返修台动作（全部委托判定/账本） ---------------- */

  function actionDefect(workId) {
    dialogState.defectWorkId = workId;
    const work = workById(workId);
    $("#defectDialogTitle").textContent = `登记缺陷 · ${work.theme}`;
    $("#defectType").value = "断线";
    $("#defectLocation").value = "";
    $("#defectDialog").showModal();
  }

  function submitDefect() {
    const artisanId = requireArtisan();
    const { defect, order } = ReworkJudge.registerDefect(store, {
      workId: dialogState.defectWorkId,
      artisanId,
      type: $("#defectType").value,
      location: $("#defectLocation").value
    });
    $("#defectDialog").close();
    refresh(order ? order.id : null);
    flash(`已登记${defect.type}：${defect.location}。新领料已冻结，已占批次维持占位` + (order ? "，沿用首次受理返修单" : "，可申请返修受理"), "warn");
  }

  function actionOpenRework(workId) {
    const artisanId = requireArtisan();
    const { order, reused } = ReworkJudge.openRework(store, workId, artisanId, "");
    refresh(order.id);
    flash(reused ? "已有未结束返修单，沿用首次受理单" : `返修单 ${shortOf(order.id)} 已受理`, reused ? "warn" : "ok");
  }

  function actionStart(orderId) {
    const artisanId = requireArtisan();
    ReworkJudge.startRepair(store, orderId, artisanId);
    refresh(orderId);
    flash("已开始修复");
  }

  function actionComplete(orderId) {
    const artisanId = requireArtisan();
    ReworkJudge.completeRework(store, orderId, artisanId);
    refresh(orderId);
    flash("返修已报完成，等待未登记缺陷者复核", "warn");
  }

  function actionApprove(orderId) {
    const artisanId = requireArtisan();
    const order = orderById(orderId);
    const msg = order.plan
      ? `确认由「${nameOf(artisanId)}」复核通过？\n将执行回退方案：进度落定 ${order.plan.from}%→${order.plan.to}%，释放 ${order.plan.releaseIds.length} 个误占批次` +
        (order.plan.requeueSlot ? "，并重排阴干位（移至队尾）" : "")
      : `确认由「${nameOf(artisanId)}」复核通过？`;
    if (!window.confirm(msg)) return;
    ReworkJudge.reviewRework(store, { orderId, artisanId, approve: true, note: "" });
    refresh();
    flash("复核通过：缺陷结案，回退方案已执行，批次余量返还");
  }

  function actionReject(orderId) {
    const artisanId = requireArtisan();
    const note = window.prompt(`由「${nameOf(artisanId)}」驳回返修，请填写原因（取消则不操作）`, "");
    if (note === null) return;
    ReworkJudge.reviewRework(store, { orderId, artisanId, approve: false, note });
    refresh(orderId);
    flash("已驳回，返修单退回修复中，误占批次恢复占位", "warn");
  }

  function actionRollback(orderId) {
    dialogState.rbOrderId = orderId;
    const order = orderById(orderId);
    const work = workById(order.workId);
    const occs = OccupationLedger.occupationsForWork(store, work.id);
    $("#rbWorkInfo").textContent = `${work.theme} · ${work.base}｜当前进度 ${work.progress}%`;
    $("#rbProgress").value = order.plan ? order.plan.to : Math.max(0, work.progress - 5);
    $("#rbProgress").max = work.progress - 1;
    $("#rbSlotWrap").style.display = work.status === "待阴干" ? "" : "none";
    $("#rbSlot").checked = order.plan ? !!order.plan.requeueSlot : work.status === "待阴干";
    $("#rbBatches").innerHTML = occs.length ? occs.map(o => {
      const b = batchById(o.batchId);
      const pending = o.status === "pendingRelease";
      return `<label class="check"><input type="checkbox" name="rbOcc" value="${o.id}" ${pending ? "checked disabled" : ""}>
        ${esc(b ? b.name : o.batchId)} · ${o.qty} 米${pending ? "（已挂待释放）" : ""}</label>`;
    }).join("") : `<div class="empty">该作品暂无占用批次</div>`;
    $("#rollbackDialog").showModal();
  }

  function submitRollback() {
    const artisanId = requireArtisan();
    const orderId = dialogState.rbOrderId;
    const releaseIds = [...document.querySelectorAll("#rbBatches input[name='rbOcc']")]
      .map(cb => {
        if (cb.checked || cb.disabled) return cb.value; // disabled 的历史待释放项继续纳入方案
        return null;
      })
      .filter(Boolean);
    ReworkJudge.rollbackProgress(store, {
      orderId,
      artisanId,
      newProgress: $("#rbProgress").value,
      releaseIds,
      requeueSlot: $("#rbSlot").checked
    });
    $("#rollbackDialog").close();
    refresh(orderId);
    flash("回退方案已登记：误占批次待复核释放，阴干位保持原位", "warn");
  }

  function actionReq(workId) {
    dialogState.reqWorkId = workId;
    const work = workById(workId);
    $("#reqTitle").textContent = `领料 · ${work.theme}`;
    $("#reqBatch").innerHTML = store.batches.map(b =>
      `<option value="${b.id}">${esc(b.name)}（${b.line}，余量 ${b.remaining} 米）</option>`).join("");
    $("#reqQty").value = 5;
    $("#reqDialog").showModal();
  }

  function submitReq() {
    const artisanId = requireArtisan();
    const workId = dialogState.reqWorkId;
    if (ReworkJudge.isRequisitionBlocked(store, workId)) {
      throw new Error("该作品存在未结案的断线/翘线缺陷，新领料已冻结；已占批次维持占位");
    }
    OccupationLedger.requisition(store, workId, $("#reqBatch").value, $("#reqQty").value);
    $("#reqDialog").close();
    refresh();
    flash("领料成功，批次已占位（操作师傅：" + nameOf(artisanId) + "）");
  }

  function actionEdit(workId) {
    dialogState.editWorkId = workId;
    const work = workById(workId);
    $("#editTitle").textContent = `胎体/纹样修正 · ${work.theme}`;
    $("#editBase").value = work.base;
    $("#editTheme").value = work.theme;
    const open = ReworkJudge.openOrderOf(store, workId);
    $("#editWarn").textContent = open
      ? "注意：胎体或纹样一经修正，当前未结束返修单立即失效，未结案缺陷随单结案。"
      : "当前没有未结束返修单，可直接修正胎体或纹样。";
    $("#editDialog").showModal();
  }

  function submitEdit() {
    const artisanId = requireArtisan();
    const workId = dialogState.editWorkId;
    const base = $("#editBase").value.trim();
    const theme = $("#editTheme").value.trim();
    if (!base || !theme) throw new Error("胎体材质与纹样主题不能为空");
    const work = workById(workId);
    if (base !== work.base || theme !== work.theme) {
      const order = ReworkJudge.invalidateByBodyOrPattern(store, {
        workId, artisanId, base, theme, reason: "胎体/纹样修正"
      });
      $("#editDialog").close();
      refresh(order ? order.id : null);
      flash(order ? "胎体/纹样已修正，旧返修单失效" : "胎体/纹样已修正", order ? "warn" : "ok");
    } else {
      $("#editDialog").close();
    }
  }

  function showWorkDetail(workId) {
    const work = workById(workId);
    const open = ReworkJudge.openOrderOf(store, workId);
    const occs = OccupationLedger.occupationsForWork(store, workId);
    const pos = OccupationLedger.slotPosition(store, workId);
    const blocked = ReworkJudge.isRequisitionBlocked(store, workId);
    $("#detailTitle").textContent = `${work.theme} · ${work.base}`;
    $("#detailContent").innerHTML = `
      <div><b>胎体：</b>${esc(work.base)}　<b>纹样：</b>${esc(work.theme)}　${work.line}　进度 ${work.progress}%</div>
      <div>状态：${work.status}｜金粉：${esc(work.gold)}｜阴干：${esc(work.dryDate)}｜交付：${esc(work.delivery)}</div>
      <div>阴干位：${pos ? "第 " + pos + " 位" : "未在阴干区"}｜领料：${blocked ? "<b style='color:var(--red)'>冻结新领料（缺陷未结案）</b>" : "正常"}</div>
      <div><b>缺陷：</b>${(work.defects || []).length ? work.defects.map(d =>
        `${d.type}·${esc(d.location)}（${nameOf(d.registrarId)} 登记，${d.resolved ? "已结案：" + esc(d.resolveNote) : "未结案"}）`).join("<br>") : "无"}</div>
      <div><b>占用批次：</b>${occs.length ? occs.map(o => {
        const b = batchById(o.batchId);
        return `${esc(b ? b.name : o.batchId)} ${o.qty} 米（${o.status === "pendingRelease" ? "待复核释放" : "占位中"}）`;
      }).join("<br>") : "无"}</div>
      <div><b>返修单：</b>${open ? `${shortOf(open.id)} · ${REWORK_LABEL[open.status]}` : "无未结束返修单"}</div>
      ${open && open.plan ? `<div class="plan-box"><b>待复核回退方案：</b>进度 ${open.plan.from}%→${open.plan.to}%；释放误占批次 ${open.plan.releaseIds.length} 个；${open.plan.requeueSlot ? "阴干位移队尾" : "阴干位不动"}。复核通过前不执行。</div>` : ""}
      <div><b>备注：</b>${esc(work.note || "无")}</div>
      <div class="logs">${work.logs.map(l => "· " + esc(l)).join("<br>")}</div>`;
    $("#detailDialog").showModal();
  }

  /* ---------------- 渲染 ---------------- */

  function filteredWorks() {
    const statusFilter = $("#statusFilter");
    const themeFilter = $("#themeFilter");
    const sortMode = $("#sortMode");
    return store.works
      .filter(w => !statusFilter.value || w.status === statusFilter.value)
      .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
      .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
  }

  function renderMiniPanels() {
    $("#miniBatches").innerHTML = store.batches.map(b => `
      <div class="mini-row ${b.remaining < b.total * 0.15 ? "low" : ""}">
        <b>${esc(b.name)}</b>
        <span>${b.line} · 余量 <b>${b.remaining}</b>/${b.total} 米</span>
      </div>`).join("");

    const slotHtml = store.slots.map((id, i) => {
      const w = workById(id);
      const open = ReworkJudge.openOrderOf(store, id);
      const pending = open && open.plan && open.plan.requeueSlot;
      return `<div class="mini-row"><span class="slot-no">#${i + 1}</span><b>${esc(w.theme)}</b>
        ${pending ? '<span class="tag warn">待重排</span>' : ""}</div>`;
    }).join("");
    $("#miniSlots").innerHTML = slotHtml || `<div class="empty">阴干区暂无工位</div>`;

    const counts = { accepted: 0, repairing: 0, review: 0 };
    store.reworks.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
    const blockedWorks = store.works.filter(w => ReworkJudge.isRequisitionBlocked(store, w.id)).length;
    $("#miniRework").innerHTML = `
      <div class="mini-row"><span>已受理</span><b>${counts.accepted}</b></div>
      <div class="mini-row"><span>修复中</span><b>${counts.repairing}</b></div>
      <div class="mini-row"><span>待复核</span><b class="${counts.review ? "hot" : ""}">${counts.review}</b></div>
      <div class="mini-row"><span>领料冻结作品</span><b>${blockedWorks}</b></div>`;
  }

  function workCard(w) {
    const open = ReworkJudge.openOrderOf(store, w.id);
    const blocked = ReworkJudge.isRequisitionBlocked(store, w.id);
    const unresolved = ReworkJudge.unresolvedDefectsOf(store, w.id);
    const pos = OccupationLedger.slotPosition(store, w.id);
    const pendingCount = store.occupations.filter(o => o.workId === w.id && o.status === "pendingRelease").length;
    const defectText = unresolved.length
      ? unresolved.map(d => `${d.type}·${esc(d.location)}`).join("；")
      : (w.defects || []).filter(d => d.resolved).length ? "历史缺陷已结案" : "无";
    const reworkBtn = open
      ? `<button class="secondary" data-action="locate" data-order="${open.id}">返修单 ${shortOf(open.id)}</button>`
      : `<button class="violet" data-action="openrw" data-id="${w.id}" ${unresolved.length ? "" : "disabled"} title="先登记断线/翘线缺陷">申请返修</button>`;
    return `<article class="item ${blocked ? "overdue" : ""}" data-ticket-work="${w.id}">
      <b>${esc(w.theme)}</b>
      <div class="meta">${esc(w.base)} · ${w.line}<br>进度 ${w.progress}% · 阴干 ${esc(w.dryDate)}${pos ? " · 工位 #" + pos : ""}<br>
      金粉：${esc(w.gold)} · 交付：${esc(w.delivery)}</div>
      <div class="chips">
        ${blocked ? '<span class="tag danger">领料冻结</span>' : '<span class="tag ok">可领料</span>'}
        ${open ? `<span class="tag violet">返修·${REWORK_LABEL[open.status]}</span>` : ""}
        ${pendingCount ? `<span class="tag warn">${pendingCount} 批待释放</span>` : ""}
      </div>
      <div class="meta ${blocked ? "defect-text" : ""}">缺陷：${defectText}</div>
      <div class="actions">
        ${WORK_STATUSES.map(s => `<button class="${s === w.status ? "secondary" : ""}" data-action="status" data-id="${w.id}" data-extra="${s}">${s}</button>`).join("")}
        <button class="warn" data-action="defect" data-id="${w.id}">记缺陷</button>
        <button class="violet" data-action="req" data-id="${w.id}" ${blocked || !store.batches.length ? "disabled" : ""}>${blocked ? "领料冻结" : "领料"}</button>
        ${reworkBtn}
        <button class="secondary" data-action="edit" data-id="${w.id}">改胎/纹</button>
        <button class="secondary" data-action="detail" data-id="${w.id}">详情</button>
      </div>
    </article>`;
  }

  function renderWorkBoard() {
    const list = filteredWorks();
    $("#board").innerHTML = WORK_STATUSES.map(status => {
      const cards = list.filter(w => w.status === status);
      return `<section class="col">
        <h3><span>${status}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(workCard).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  function reworkTicket(order) {
    const w = workById(order.workId);
    if (!w) {
      return `<article class="ticket ${order.status}" data-ticket="${order.id}">
        <div class="ticket-head"><b>已删作品</b><span class="ticket-id">${shortOf(order.id)}</span></div>
        <div class="meta">作品已不存在，请刷新页面由加载对账清理。</div>
      </article>`;
    }
    const defects = (w.defects || []).filter(d => order.defectIds.includes(d.id));
    const me = currentArtisanId();
    const iAmRegistrar = order.registrarIds.includes(me);
    let actions = "";
    if (order.status === "accepted") {
      actions = `<button data-action="start" data-order="${order.id}">开始修复</button>`;
    } else if (order.status === "repairing") {
      actions = `<button class="warn" data-action="rollback" data-order="${order.id}">回退进度</button>
                 <button class="secondary" data-action="complete" data-order="${order.id}">报完成</button>`;
    } else if (order.status === "review") {
      actions = `<button data-action="approve" data-order="${order.id}" ${iAmRegistrar ? "disabled" : ""} title="${iAmRegistrar ? "您登记过本单缺陷，不能复核" : ""}">复核通过</button>
                 <button class="danger" data-action="reject" data-order="${order.id}" ${iAmRegistrar ? "disabled" : ""}>驳回</button>`;
    }
    const plan = order.plan;
    return `<article class="ticket ${order.status}" data-ticket="${order.id}">
      <div class="ticket-head"><b>${esc(w.theme)}</b><span class="ticket-id">${shortOf(order.id)}</span></div>
      <div class="meta">${esc(w.base)} · ${esc(w.line)}</div>
      <div class="meta">申请人：${nameOf(order.applicantId)}｜缺陷登记：${order.registrarIds.map(nameOf).join("、")}</div>
      <div class="defects">${defects.map(d => `<div>${d.type}·${esc(d.location)} <span class="meta">(${nameOf(d.registrarId)})</span></div>`).join("")}</div>
      ${plan ? `<div class="plan-box">待复核方案：进度 ${plan.from}%→${plan.to}%；
        释放批次 ${plan.releaseIds.map(id => {
          const o = store.occupations.find(x => x.id === id);
          const b = o && batchById(o.batchId);
          return esc(b ? b.name : id);
        }).join("、") || "无"}；${plan.requeueSlot ? "阴干位移队尾" : "阴干位不动"}。<b>复核前不释放、不重排。</b></div>` : ""}
      ${order.status === "review" && iAmRegistrar ? '<div class="meta" style="color:var(--red)">您登记过本单缺陷，须由其他师傅复核。</div>' : ""}
      <div class="actions">${actions}<button class="secondary" data-action="detail" data-id="${w.id}">作品详情</button></div>
    </article>`;
  }

  function renderReworkBoard() {
    $("#reworkBoard").innerHTML = REWORK_COLUMNS.map(col => {
      const orders = store.reworks.filter(r => r.status === col.key);
      return `<section class="col">
        <h3><span>${col.title}</span><span>${orders.length}</span></h3>
        ${orders.length ? orders.map(reworkTicket).join("") : `<div class="empty">暂无返修单</div>`}
      </section>`;
    }).join("");

    const closed = store.reworks
      .filter(r => r.status === "approved" || r.status === "invalid")
      .sort((a, b) => (b.reviewedAt || b.createdAt || "").localeCompare(a.reviewedAt || a.createdAt || ""))
      .slice(0, 8);
    $("#historyList").innerHTML = closed.length ? closed.map(r => {
      const w = workById(r.workId);
      return `<div class="hist ${r.status}">
        <span class="tag ${r.status === "approved" ? "ok" : "danger"}">${REWORK_LABEL[r.status]}</span>
        <b>${esc(w ? w.theme : "已删作品")}</b>
        <span class="meta">${shortOf(r.id)}${r.status === "approved" ? " · 复核 " + nameOf(r.reviewerId) : " · " + esc(r.invalidReason || "")}</span>
      </div>`;
    }).join("") : `<div class="empty">暂无已结案返修单</div>`;
  }

  function render() {
    renderMiniPanels();
    renderWorkBoard();
    renderReworkBoard();
  }

  /* ---------------- 事件绑定 ---------------- */

  function wire() {
    $("#artisanSelect").addEventListener("change", e => {
      store.currentArtisanId = e.target.value;
      persist();
      render();
    });

    $("#workForm").addEventListener("submit", e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      try {
        createWork(data);
        e.target.reset();
        e.target.elements.dryDate.value = todayStr();
        e.target.elements.delivery.value = offsetDate(5);
      } catch (err) { flash(err.message, "error"); }
    });

    $("#batchForm").addEventListener("submit", e => {
      e.preventDefault();
      try {
        addBatch(Object.fromEntries(new FormData(e.target).entries()));
        e.target.reset();
      } catch (err) { flash(err.message, "error"); }
    });

    ["#statusFilter", "#themeFilter", "#sortMode"].forEach(sel => {
      $(sel).addEventListener("input", render);
    });
    $("#clearFilters").addEventListener("click", () => {
      $("#themeFilter").value = "";
      $("#statusFilter").value = "";
      render();
    });

    $("#saveDefect").addEventListener("click", () => { try { submitDefect(); } catch (err) { flash(err.message, "error"); } });
    $("#confirmReq").addEventListener("click", () => { try { submitReq(); } catch (err) { flash(err.message, "error"); } });
    $("#saveEdit").addEventListener("click", () => { try { submitEdit(); } catch (err) { flash(err.message, "error"); } });
    $("#confirmRollback").addEventListener("click", () => { try { submitRollback(); } catch (err) { flash(err.message, "error"); } });

    $("#exportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "rework-unlock-station.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });

    document.addEventListener("click", e => {
      const btn = e.target.closest("[data-action]");
      if (!btn || btn.disabled) return;
      const { action, id, order, extra } = btn.dataset;
      try {
        if (action === "status") changeWorkStatus(id, extra);
        else if (action === "defect") actionDefect(id);
        else if (action === "req") actionReq(id);
        else if (action === "openrw") actionOpenRework(id);
        else if (action === "edit") actionEdit(id);
        else if (action === "detail") showWorkDetail(id);
        else if (action === "start") actionStart(order);
        else if (action === "complete") actionComplete(order);
        else if (action === "approve") actionApprove(order);
        else if (action === "reject") actionReject(order);
        else if (action === "rollback") actionRollback(order);
        else if (action === "locate") {
          const el = document.querySelector(`[data-ticket="${order}"]`);
          if (el) {
            el.classList.add("flash");
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            setTimeout(() => el.classList.remove("flash"), 1800);
          }
        }
      } catch (err) { flash(err.message, "error"); }
    });

    window.addEventListener("storage", e => {
      if (e.key === STORAGE_KEY) {
        try {
          store = JSON.parse(e.newValue);
          ReworkJudge.reconcileReworks(store);
          OccupationLedger.reconcile(store);
          render();
        } catch (err) { /* 忽略损坏的跨页数据 */ }
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    const workForm = $("#workForm");
    workForm.elements.dryDate.value = todayStr();
    workForm.elements.delivery.value = offsetDate(5);
    $("#statusFilter").innerHTML = `<option value="">全部状态</option>` +
      WORK_STATUSES.map(s => `<option>${s}</option>`).join("");

    const reports = load(); // 刷新后对账：作品、批次余量、工位顺序一致
    const select = $("#artisanSelect");
    select.innerHTML = store.artisans.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
    select.value = store.currentArtisanId || store.artisans[0].id;
    store.currentArtisanId = select.value;

    wire();
    render();
    if (reports.length) flash("加载对账：" + reports.join("；"), "warn");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
