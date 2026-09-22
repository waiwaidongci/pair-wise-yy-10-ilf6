// 返修判定：返修单的受理、完成、复核、失效与释放资格规则
const Rework = (() => {
  const STATUS_LABEL = { open: "返修中", done: "待复核", closed: "已复核", void: "已失效" };

  // 未结束：返修中(open)、待复核(done)、已复核但尚未释放(closed 且未释放)
  function isActive(rework) {
    return rework.status === "open" || rework.status === "done" ||
      (rework.status === "closed" && !rework.released);
  }

  function activeOf(state, workId) {
    return state.reworks.find(r => r.workId === workId && isActive(r)) || null;
  }

  // 每件作品同时只留一张未结束返修单；重复或并发申请沿用首次受理
  //（查找与创建在同一段同步代码内完成，并发登记只会命中首次受理单）
  function apply(state, workId, type, reporter, note) {
    const existing = activeOf(state, workId);
    if (existing) return { rework: existing, reused: true };
    const rework = {
      id: crypto.randomUUID(),
      workId,
      type,
      note: note || "",
      reporter,
      status: "open",
      createdAt: new Date().toLocaleString(),
      doneAt: "",
      reviewer: "",
      reviewedAt: "",
      voidReason: "",
      released: false
    };
    state.reworks.unshift(rework);
    return { rework, reused: false };
  }

  function complete(state, reworkId) {
    const rework = state.reworks.find(r => r.id === reworkId);
    if (!rework || rework.status !== "open") return { ok: false, reason: "仅返修中的工单可标记完成" };
    rework.status = "done";
    rework.doneAt = new Date().toLocaleString();
    return { ok: true, rework };
  }

  // 返修完成由未登记缺陷者复核
  function review(state, reworkId, reviewer) {
    const rework = state.reworks.find(r => r.id === reworkId);
    if (!rework || rework.status !== "done") return { ok: false, reason: "仅待复核的工单可复核" };
    if (reviewer === rework.reporter) return { ok: false, reason: "复核人不能是缺陷登记人，请切换操作人" };
    rework.status = "closed";
    rework.reviewer = reviewer;
    rework.reviewedAt = new Date().toLocaleString();
    return { ok: true, rework };
  }

  // 胎体或纹样修正让旧返修失效
  function voidForCorrection(state, workId, reason) {
    const rework = activeOf(state, workId);
    if (!rework) return null;
    rework.status = "void";
    rework.voidReason = reason;
    return rework;
  }

  // 复核前不得释放：仅已复核且未释放的工单允许回退释放
  function releasable(state, workId) {
    return state.reworks.find(r => r.workId === workId && r.status === "closed" && !r.released) || null;
  }

  return { STATUS_LABEL, isActive, activeOf, apply, complete, review, voidForCorrection, releasable };
})();
