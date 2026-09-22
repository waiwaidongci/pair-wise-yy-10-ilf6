/* 纯 Node 冒烟测试：加载三个业务源码，验证返修解锁台核心规则。运行：node test-rules.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = { console, Date, Math, JSON, Array, Object, Number, String, Set, Map };
context.globalThis = context;
vm.createContext(context);
["occupation-ledger.js", "rework-judge.js"].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), context, { filename: f });
});
const L = context.OccupationLedger;
const J = context.ReworkJudge;

let passed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS", name); passed++; }
  catch (e) { console.error("FAIL", name, "->", e.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function expectThrow(fn, msg) {
  try { fn(); } catch (e) { if (msg && !e.message.includes(msg)) throw new Error(`报错信息不符：${e.message}`); return; }
  throw new Error("应当抛错但没有：" + msg);
}

function freshStore() {
  const s = {
    version: 1,
    currentArtisanId: "a1",
    artisans: [{ id: "a1", name: "林秀珍" }, { id: "a2", name: "陈阿强" }, { id: "a3", name: "周敏" }],
    works: [
      { id: "w1", base: "木胎", theme: "缠枝莲", line: "细线", progress: 60, dryDate: "2026-09-22", gold: "未处理", delivery: "2026-10-01", status: "待阴干", note: "", logs: [], defects: [] },
      { id: "w2", base: "竹胎", theme: "云雷纹", line: "中线", progress: 30, dryDate: "2026-09-25", gold: "未处理", delivery: "2026-10-05", status: "贴线中", note: "", logs: [], defects: [] }
    ],
    batches: [
      { id: "b1", name: "朱红甲批", line: "中线", total: 100, remaining: 70 },
      { id: "b2", name: "金漆乙批", line: "细线", total: 50, remaining: 50 }
    ],
    occupations: [{ id: "o1", workId: "w1", batchId: "b1", qty: 30, at: "t", status: "held", orderId: null, releasedAt: "" }],
    reworks: [],
    slots: ["w1"]
  };
  return s;
}

check("初始账本对账：余量按占位重算，工位保留", () => {
  const s = freshStore();
  const r = L.reconcile(s);
  assert(s.batches[0].remaining === 70, "b1 余量应为 70，实际 " + s.batches[0].remaining);
  assert(s.slots.join() === "w1", "阴干位应保留 w1");
  assert(Array.isArray(r), "对账应返回报告");
});

check("登记断线后冻结新领料，但已占批次维持占位", () => {
  const s = freshStore();
  L.requisition(s, "w2", "b2", 10);
  assert(s.batches[1].remaining === 40, "领料后 b2 余量 40");
  J.registerDefect(s, { workId: "w2", artisanId: "a1", type: "断线", location: "左瓣" });
  assert(J.isRequisitionBlocked(s, "w2"), "w2 新领料应冻结");
  assert(s.batches[1].remaining === 40, "登记缺陷不改变批次余量");
  const occs = L.occupationsForWork(s, "w2");
  assert(occs.length === 1 && occs[0].status === "held", "已占批次维持占位，实际 " + occs.map(o => o.status).join(","));
});

check("无缺陷不能受理返修；申请后同作品重复/并发沿用首次受理", () => {
  const s = freshStore();
  expectThrow(() => J.openRework(s, "w1", "a2"), "先登记");
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "翘线", location: "顶边" });
  const r1 = J.openRework(s, "w1", "a2");
  assert(!r1.reused, "首次应当新建受理单");
  const r2 = J.openRework(s, "w1", "a3");
  assert(r2.reused && r2.order.id === r1.order.id, "重复申请必须沿用首单");
  J.registerDefect(s, { workId: "w1", artisanId: "a3", type: "断线", location: "侧边" });
  assert(r1.order.defectIds.length === 2, "补登缺陷应并入首单");
});

check("修复→回退方案（复核前不释放不重排不落定）→ 职责分离复核 → 解锁", () => {
  const s = freshStore();
  L.requisition(s, "w1", "b2", 8); // occ 新
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "右瓣" });
  const { order } = J.openRework(s, "w1", "a1");
  J.startRepair(s, order.id, "a2");
  const occs = L.occupationsForWork(s, "w1");
  assert(occs.length === 2, "w1 占两个批次");
  const o1 = occs.find(o => o.qty === 30);
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 40, releaseIds: [o1.id], requeueSlot: true });
  // 复核前：批次 pendingRelease 但仍占位、余量不返还；阴干位不动；进度不变
  assert(s.batches[0].remaining === 70, "b1 余量复核前不返还，实际 " + s.batches[0].remaining);
  assert(o1.status === "pendingRelease", "误占批次挂待释放");
  assert(s.slots[0] === "w1" && s.slots.length === 1, "阴干位复核前不重排");
  const w = s.works[0];
  assert(w.progress === 60, "进度复核前不落定");
  // 修复中不能复核
  expectThrow(() => J.reviewRework(s, { orderId: order.id, artisanId: "a3", approve: true }), "待复核");
  J.completeRework(s, order.id, "a2"); // 先完成
  // 登记缺陷者 a1 不能复核
  expectThrow(() => J.reviewRework(s, { orderId: order.id, artisanId: "a1", approve: true }), "不能登记过本单缺陷");
  // 另一位未登记缺陷者 a3 复核通过
  J.reviewRework(s, { orderId: order.id, artisanId: "a3", approve: true, note: "合格" });
  assert(o1.status === "released", "复核通过后误占批次释放");
  assert(s.batches[0].remaining === 100, "b1 余量应返还为 100，实际 " + s.batches[0].remaining);
  assert(s.slots[0] === "w1", "w1 重排后仍在（唯一元素移队尾）");
  assert(w.progress === 40, "进度应落定为 40，实际 " + w.progress);
  assert(order.status === "approved", "返修单应复核通过");
  assert(!J.isRequisitionBlocked(s, "w1"), "结案后领料解冻");
  assert(w.defects[0].resolved, "缺陷应结案");
});

check("驳回复核：待释放批次恢复占位，阴干位不动，退回修复中", () => {
  const s = freshStore();
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "x" });
  const { order } = J.openRework(s, "w1", "a1");
  J.startRepair(s, order.id, "a2");
  const o1 = s.occupations.find(o => o.id === "o1");
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 20, releaseIds: ["o1"], requeueSlot: true });
  J.completeRework(s, order.id, "a2");
  J.reviewRework(s, { orderId: order.id, artisanId: "a3", approve: false, note: "仍翘" });
  assert(o1.status === "held", "驳回后批次恢复占位");
  assert(s.batches[0].remaining === 70, "驳回后余量不返还");
  assert(order.status === "repairing", "单据退回修复中");
  assert(s.works[0].progress === 60, "进度不应落定");
});

check("胎体或纹样修正使未结束返修单失效，领料解冻，未复核方案作废", () => {
  const s = freshStore();
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "x" });
  const { order } = J.openRework(s, "w1", "a1");
  J.startRepair(s, order.id, "a2");
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 20, releaseIds: ["o1"], requeueSlot: true });
  const o1 = s.occupations.find(o => o.id === "o1");
  const inv = J.invalidateByBodyOrPattern(s, { artisanId: "a3", workId: "w1", base: "木胎", theme: "海水江崖", reason: "纹样改稿" });
  assert(inv.status === "invalid", "旧单应失效");
  assert(o1.status === "held", "未复核方案作废，批次恢复占位");
  assert(!J.openOrderOf(s, "w1"), "不应再有未结束单");
  assert(!J.isRequisitionBlocked(s, "w1"), "失效后领料解冻");
  assert(s.works[0].theme === "海水江崖", "纹样应更新");
  assert(s.batches[0].remaining === 70, "批次维持占位不释放");
  // 失效后可以重新登记并受理
  J.registerDefect(s, { workId: "w1", artisanId: "a2", type: "翘线", location: "新稿接缝" });
  const r2 = J.openRework(s, "w1", "a2");
  assert(!r2.reused, "失效后应允许新返修单");
});

check("刷新对账：重复未结束单归并到首次受理，待释放孤单恢复占位，工位顺序校正", () => {
  const s = freshStore();
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "x" });
  const first = J.openRework(s, "w1", "a1").order;
  // 手工伪造并发产生的第二张未结束单
  s.reworks.push({
    id: "rw-fake", workId: "w1", applicantId: "a2", status: "accepted", createdAt: "2099-01-01",
    defectIds: [], registrarIds: [], plan: null, completedAt: "", completerId: "",
    reviewerId: "", reviewedAt: "", reviewNote: "", invalidReason: "", logs: []
  });
  // 伪造无主待释放
  s.occupations.push({ id: "o9", workId: "w2", batchId: "b2", qty: 5, at: "t", status: "pendingRelease", orderId: "rw-gone", releasedAt: "" });
  // 伪造工位脏数据：重复 w1 + 非待阴干作品 w2 + 不存在作品
  s.slots = ["w1", "wx", "w2", "w1"];
  L.reconcile(s);
  J.reconcileReworks(s);
  assert(J.openOrderOf(s, "w1").id === first.id, "应沿用最早创建的首单");
  assert(s.reworks.find(r => r.id === "rw-fake").status === "invalid", "并发重复单应失效");
  const o9 = s.occupations.find(o => o.id === "o9");
  assert(o9.status === "held", "失去复核依据的待释放应恢复占位");
  assert(s.slots.join() === "w1", "工位应去重并剔除非待阴干作品，实际 " + s.slots.join());
  assert(s.batches[1].remaining === 45, "o9 恢复占位后 b2 余量 45");
});

check("领料与批次余量边界：余量不足拦截，释放后返还", () => {
  const s = freshStore();
  expectThrow(() => L.requisition(s, "w2", "b1", 71), "余量不足");
  L.requisition(s, "w2", "b1", 30);
  assert(s.batches[0].remaining === 40, "b1 再领 30 后余量 40，实际 " + s.batches[0].remaining);
});

check("待释放批次复核驳回后可再次登记新方案", () => {
  const s = freshStore();
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "x" });
  const { order } = J.openRework(s, "w1", "a1");
  J.startRepair(s, order.id, "a2");
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 50, releaseIds: ["o1"] });
  J.completeRework(s, order.id, "a2");
  J.reviewRework(s, { orderId: order.id, artisanId: "a3", approve: false, note: "n" });
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 45, releaseIds: ["o1"] });
  assert(order.plan.to === 45, "应能重新登记方案");
  J.completeRework(s, order.id, "a2");
  J.reviewRework(s, { orderId: order.id, artisanId: "a3", approve: true });
  assert(s.batches[0].remaining === 100, "再次方案复核后释放，余量 100");
});

check("修复中重复登记回退方案：旧选择恢复占位，新选择待释放", () => {
  const s = freshStore();
  L.requisition(s, "w1", "b2", 6);
  J.registerDefect(s, { workId: "w1", artisanId: "a1", type: "断线", location: "x" });
  const { order } = J.openRework(s, "w1", "a1");
  J.startRepair(s, order.id, "a2");
  const occs = L.occupationsForWork(s, "w1");
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 50, releaseIds: ["o1"] });
  // 第二次改方案：取消 o1，改释放 b2 批次
  const o2 = occs.find(o => o.batchId === "b2");
  J.rollbackProgress(s, { orderId: order.id, artisanId: "a2", newProgress: 45, releaseIds: [o2.id] });
  const o1 = s.occupations.find(o => o.id === "o1");
  assert(o1.status === "held", "取消选择的批次应恢复占位");
  assert(o2.status === "pendingRelease" && o2.orderId === order.id, "新选批次应挂待释放");
  assert(order.plan.releaseIds.join() === o2.id, "方案只含新批次");
  assert(s.batches[0].remaining === 70 && s.batches[1].remaining === 44, "两次登记期间余量始终不返还");
});

console.log(`\n${passed} 项检查全部通过`);
