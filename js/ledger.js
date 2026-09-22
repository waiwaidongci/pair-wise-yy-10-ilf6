// 占用账本：线材批次占位、误占释放与阴干位排队
const Ledger = (() => {
  function usedOf(batch) {
    return batch.holds.reduce((sum, h) => sum + h.qty, 0);
  }

  function remaining(batch) {
    return batch.total - batch.holds.reduce((sum, h) => sum + h.qty, 0);
  }

  function holdsOf(state, workId) {
    const list = [];
    state.batches.forEach(batch => batch.holds.forEach(h => {
      if (h.workId === workId) list.push({ batch, qty: h.qty });
    }));
    return list;
  }

  // 新领料占位；是否允许领料由返修判定把关，账本只保证不超占
  function occupy(state, workId, batchId, qty) {
    const batch = state.batches.find(b => b.id === batchId);
    if (!batch) return { ok: false, reason: "批次不存在" };
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "领料数量需大于 0" };
    if (remaining(batch) < qty) return { ok: false, reason: "批次余量不足" };
    const hold = batch.holds.find(h => h.workId === workId);
    if (hold) hold.qty += qty;
    else batch.holds.push({ workId, qty });
    return { ok: true, batch };
  }

  // 进度回退时释放误占批次，返回释放总量
  function releaseByWork(state, workId) {
    let freed = 0;
    state.batches.forEach(batch => {
      batch.holds = batch.holds.filter(h => {
        if (h.workId === workId) { freed += h.qty; return false; }
        return true;
      });
    });
    return freed;
  }

  // 阴干位：进入待阴干时占用队首空位
  function takeSlot(state, workId) {
    if (state.slots.some(s => s.workId === workId)) return null;
    const slot = state.slots.find(s => !s.workId);
    if (slot) slot.workId = workId;
    return slot || null;
  }

  function freeSlot(state, workId) {
    const slot = state.slots.find(s => s.workId === workId);
    if (slot) slot.workId = null;
    return slot || null;
  }

  // 重排阴干位：保持在列作品的先后顺序，向队首压缩空位
  function rearrange(state) {
    const queued = state.slots.map(s => s.workId).filter(Boolean);
    state.slots.forEach((slot, i) => { slot.workId = queued[i] || null; });
  }

  return { usedOf, remaining, holdsOf, occupy, releaseByWork, takeSlot, freeSlot, rearrange };
})();
