/* jsdom 渲染冒烟：真实加载 index.html + 三个业务源码，模拟完整返修流程。
 * 依赖可选：未安装 jsdom 时自动跳过（npm i -D jsdom 后即可运行）。 */
let JSDOM;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (e) {
  try { JSDOM = require("/tmp/jsdom-check/node_modules/jsdom").JSDOM; }
  catch (e2) {
    console.log("SKIP 渲染冒烟：未安装 jsdom（规则冒烟请运行 node test-rules.js）");
    process.exit(0);
  }
}
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function makeDom() {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.HTMLDialogElement && (window.HTMLDialogElement.prototype.showModal = function () { this.open = true; });
  window.HTMLDialogElement && (window.HTMLDialogElement.prototype.close = function () { this.open = false; });
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function () {};

  const errors = [];
  window.addEventListener("error", e => errors.push(e.message));

  ["occupation-ledger.js", "rework-judge.js", "page-state.js"].forEach(f => {
    const code = fs.readFileSync(path.join(__dirname, f), "utf8");
    try { window.eval(code); } catch (e) { errors.push(f + ": " + e.stack); }
  });

  // 手动触发 DOMContentLoaded（outside-only 模式下不会自动触发）
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));

  return { window, dom, errors };
}

function click(window, selector) {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error("找不到元素: " + selector);
  if (el.disabled) throw new Error("元素被禁用: " + selector);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

let step = 0;
function check(name, fn) {
  try { fn(); console.log("PASS", name); step++; }
  catch (e) { console.error("FAIL", name, "->", e.message); process.exitCode = 1; }
}

const { window, errors } = makeDom();
const doc = window.document;

check("首屏无脚本错误", () => {
  if (errors.length) throw new Error(errors.join("\n"));
});

check("种子数据渲染：3 张作品卡、返修列有单据、批次余量正确", () => {
  const cards = doc.querySelectorAll("#board .item");
  if (cards.length !== 3) throw new Error("作品卡数量 " + cards.length);
  if (doc.querySelector('.ticket[data-ticket="rw1"]') === null) throw new Error("修复中列应有 rw1");
  const batches = doc.querySelector("#miniBatches").textContent;
  if (!batches.includes("101") || !batches.includes("70") || !batches.includes("60")) {
    throw new Error("批次余量显示异常: " + batches.replace(/\s+/g, " "));
  }
  if (doc.querySelector("#miniSlots").textContent.includes("#1") === false) throw new Error("阴干位应显示 #1");
});

check("职责分离：当前师傅林秀珍是 rw1 缺陷登记人，待复核按钮应禁用（先推进到待复核）", () => {
  // rw1 已在修复中且有回退方案；直接点“报完成”
  click(window, '.ticket[data-ticket="rw1"] button[data-action="complete"]');
  const approveBtn = doc.querySelector('.ticket[data-ticket="rw1"] button[data-action="approve"]');
  if (!approveBtn) throw new Error("应出现复核通过按钮");
  if (!approveBtn.disabled) throw new Error("登记人复核按钮必须禁用");
  // 切换为周敏（未登记缺陷者）
  const sel = doc.querySelector("#artisanSelect");
  sel.value = "a3";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  const approveBtn2 = doc.querySelector('.ticket[data-ticket="rw1"] button[data-action="approve"]');
  if (approveBtn2.disabled) throw new Error("周敏应当可以复核");
});

check("周敏复核通过：confirm 确认后批次释放、阴干重排、进度落定", () => {
  window.confirm = () => true;
  click(window, '.ticket[data-ticket="rw1"] button[data-action="approve"]');
  const batches = doc.querySelector("#miniBatches").textContent.replace(/\s+/g, " ");
  if (!batches.includes("105")) throw new Error("occ2 4米返还后 b1 余量应为 105: " + batches);
  const w1Card = doc.querySelector('[data-ticket-work="w1"]');
  if (!w1Card.textContent.includes("进度 70%")) throw new Error("进度应落定 70%");
  if (w1Card.querySelector(".tag.danger")) throw new Error("结案后不应再显示领料冻结");
});

check("登记缺陷冻结领料、已占批次维持占位", () => {
  const sel = doc.querySelector("#artisanSelect");
  sel.value = "a2";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  // 给 w3（云雷纹）登记翘线
  click(window, '[data-ticket-work="w3"] button[data-action="defect"]');
  doc.querySelector("#defectLocation").value = "回纹转角";
  doc.querySelector("#defectType").value = "翘线";
  doc.querySelector("#saveDefect").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const w3 = doc.querySelector('[data-ticket-work="w3"]');
  if (!w3.querySelector(".tag.danger")) throw new Error("w3 应显示领料冻结标签");
  const reqBtn = w3.querySelector('button[data-action="req"]');
  if (!reqBtn.disabled) throw new Error("领料按钮应禁用");
  const batches = doc.querySelector("#miniBatches").textContent.replace(/\s+/g, " ");
  if (!batches.includes("105")) throw new Error("已占批次余量不应改变: " + batches);
});

check("申请返修→修复→胎体修正使旧单失效→领料解冻", () => {
  click(window, '[data-ticket-work="w3"] button[data-action="openrw"]');
  let ticket = doc.querySelector("#reworkBoard .col:nth-child(1) .ticket");
  if (!ticket) throw new Error("应出现已受理返修单");
  click(window, '#reworkBoard .col:nth-child(1) .ticket button[data-action="start"]');
  // 改纹样
  click(window, '[data-ticket-work="w3"] button[data-action="edit"]');
  doc.querySelector("#editTheme").value = "云雷卷草";
  doc.querySelector("#saveEdit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (doc.querySelector("#reworkBoard .col:nth-child(1) .ticket, #reworkBoard .col:nth-child(2) .ticket")) {
    throw new Error("未结束返修单应已消失");
  }
  const hist = doc.querySelector("#historyList").textContent;
  if (!hist.includes("沿用首次受理") && !hist.includes("胎体/纹样修正")) throw new Error("历史区应显示失效原因");
  const w3 = doc.querySelector('[data-ticket-work="w3"]');
  if (w3.querySelector(".tag.danger")) throw new Error("失效后领料应解冻");
});

check("刷新后（重新解析 localStorage）作品、余量、工位一致", () => {
  const saved = window.localStorage.getItem("zfl42ReworkStationV1");
  const { window: w2, errors: e2 } = makeDom();
  w2.localStorage.setItem("zfl42ReworkStationV1", saved);
  w2.document.dispatchEvent(new w2.Event("DOMContentLoaded", { bubbles: true }));
  if (e2.length) throw new Error(e2.join("\n"));
  const batches = w2.document.querySelector("#miniBatches").textContent.replace(/\s+/g, " ");
  if (!batches.includes("105")) throw new Error("刷新后 b1 余量仍应为 105: " + batches);
  if (!w2.document.querySelector("#miniSlots").textContent.includes("缠枝莲")) throw new Error("阴干位应仍有缠枝莲");
  if (!w2.document.querySelector('[data-ticket-work="w1"]').textContent.includes("进度 70%")) {
    throw new Error("刷新后进度应保持 70%");
  }
});

console.log(`\n${step} 项渲染检查全部通过`);
