// 页面状态：数据持久化、动作编排与界面渲染
const STORAGE_KEY = "zfl42ReworkStation";
const OPERATOR_KEY = "zfl42Operator";
const OPERATORS = ["林师傅", "陈师傅", "黄师傅"];
const STATUSES = ["贴线中", "待阴干", "上金粉", "待交付"];
const today = new Date().toISOString().slice(0, 10);
const offsetDate = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const now = () => new Date().toLocaleString();

function seedState() {
  return {
    works: [
      { id: "seed-w1", base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70, dryDate: today, gold: "未处理", defect: "", delivery: offsetDate(6), status: "待阴干", note: "边线需保持低浮雕感", logs: ["创建作品"] },
      { id: "seed-w2", base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95, dryDate: offsetDate(-2), gold: "试扫粉", defect: "翘线：左侧枝干", delivery: offsetDate(1), status: "上金粉", note: "客户要求金粉偏暗", logs: ["创建作品", "陈师傅 登记翘线，返修单受理"] },
      { id: "seed-w3", base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40, dryDate: offsetDate(2), gold: "未处理", defect: "", delivery: offsetDate(8), status: "贴线中", note: "", logs: ["创建作品"] }
    ],
    batches: [
      { id: "seed-b1", name: "细线·A批", total: 20, holds: [{ workId: "seed-w2", qty: 3 }] },
      { id: "seed-b2", name: "中线·B批", total: 30, holds: [{ workId: "seed-w1", qty: 2 }] },
      { id: "seed-b3", name: "粗线·C批", total: 12, holds: [] }
    ],
    slots: Array.from({ length: 6 }, (_, i) => ({ id: `seed-s${i + 1}`, workId: i === 0 ? "seed-w1" : null })),
    reworks: [
      { id: "seed-r1", workId: "seed-w2", type: "翘线", note: "左侧枝干", reporter: "陈师傅", status: "open", createdAt: now(), doneAt: "", reviewer: "", reviewedAt: "", voidReason: "", released: false }
    ]
  };
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

let state = load() || seedState();
let currentOperator = localStorage.getItem(OPERATOR_KEY) || OPERATORS[0];
let activeId = null;

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const $ = sel => document.querySelector(sel);
const form = $("#workForm");
const board = $("#board");
const statusFilter = $("#statusFilter");
const themeFilter = $("#themeFilter");
const sortMode = $("#sortMode");
const dialog = $("#detailDialog");
const operatorSelect = $("#operatorSelect");

const byId = id => state.works.find(w => w.id === id);
const workName = id => {
  const w = byId(id);
  return w ? `${w.theme}·${w.base}` : "未知作品";
};

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function holdText(workId) {
  const holds = Ledger.holdsOf(state, workId);
  return holds.length ? holds.map(h => `${h.batch.name}×${h.qty}`).join("、") : "无占用";
}

// ---- 动作编排 ----

// 登记断线/翘线：受理返修单后只阻止新的领料，已占线材批次维持占位
function registerDefect(workId, type) {
  const work = byId(workId);
  const input = prompt(`记录「${type}」位置与说明（可留空）`);
  if (input === null) return;
  const { rework, reused } = Rework.apply(state, workId, type, currentOperator, input.trim());
  if (reused) {
    toast("该作品已有未结束返修单，沿用首次受理");
  } else {
    work.defect = rework.note ? `${type}：${rework.note}` : type;
    work.logs.push(`${now()} ${currentOperator} 登记${type}，返修单受理`);
    toast(`已受理${type}返修单：新的领料已阻止，已占批次维持占位`);
  }
  save();
  render();
}

function completeRework(reworkId) {
  const result = Rework.complete(state, reworkId);
  if (!result.ok) return toast(result.reason);
  byId(result.rework.workId).logs.push(`${now()} 返修完成，待复核`);
  toast("返修已完成，待未登记缺陷者复核");
  save();
  render();
}

function reviewRework(reworkId) {
  const result = Rework.review(state, reworkId, currentOperator);
  if (!result.ok) return toast(result.reason);
  byId(result.rework.workId).logs.push(`${now()} ${currentOperator} 复核通过`);
  toast("复核通过，可执行进度回退释放");
  save();
  render();
}

// 进度回退：释放误占批次并重排阴干位，复核前不得释放
function rollbackWork(workId) {
  const rework = Rework.releasable(state, workId);
  if (!rework) return toast("复核前不得释放误占批次与阴干位");
  const work = byId(workId);
  const freed = Ledger.releaseByWork(state, workId);
  Ledger.freeSlot(state, workId);
  Ledger.rearrange(state);
  rework.released = true;
  work.progress = Math.max(0, work.progress - 30);
  work.status = "贴线中";
  work.defect = "";
  work.logs.push(`${now()} 进度回退至 ${work.progress}%，释放误占线材 ${freed}，重排阴干位`);
  toast(`已回退进度，释放误占线材 ${freed} 件并重排阴干位`);
  save();
  render();
}

function updateStatus(id, status) {
  const work = byId(id);
  const prev = work.status;
  if (prev === status) return;
  work.status = status;
  if (status === "待阴干") Ledger.takeSlot(state, id);
  if (prev === "待阴干" && status !== "待阴干") {
    Ledger.freeSlot(state, id);
    Ledger.rearrange(state);
  }
  if (status === "上金粉") work.gold = "已上金粉";
  if (status === "待交付") work.progress = 100;
  work.logs.push(`${now()} 状态 ${prev} → ${status}`);
  save();
  render();
}

// ---- 渲染 ----

function filtered() {
  return state.works
    .filter(w => !statusFilter.value || w.status === statusFilter.value)
    .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
    .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
}

function reworkCard(r) {
  const label = Rework.STATUS_LABEL[r.status] + (r.status === "closed" && !r.released ? "·待释放" : "");
  const tagClass = r.status === "void" ? "gray" : r.status === "done" ? "amber" : "";
  const actions = [];
  if (r.status === "open") actions.push(`<button onclick="completeRework('${r.id}')">完成返修</button>`);
  if (r.status === "done") {
    const same = currentOperator === r.reporter;
    actions.push(`<button class="violet" ${same ? "disabled title='复核人不能是缺陷登记人，请切换操作人'" : ""} onclick="reviewRework('${r.id}')">复核</button>`);
  }
  if (r.status === "closed" && !r.released) actions.push(`<button class="warn" onclick="rollbackWork('${r.workId}')">回退释放</button>`);
  return `<article class="item ${r.status === "void" ? "voided" : ""}">
    <b>${workName(r.workId)} · ${r.type}</b><span class="tag ${tagClass}">${label}</span>
    <div class="meta">登记人 ${r.reporter} · ${r.createdAt}${r.note ? ` · ${r.note}` : ""}</div>
    ${r.doneAt ? `<div class="meta">完成于 ${r.doneAt}</div>` : ""}
    ${r.reviewer ? `<div class="meta">复核人 ${r.reviewer} · ${r.reviewedAt}</div>` : ""}
    ${r.voidReason ? `<div class="meta">失效原因：${r.voidReason}</div>` : ""}
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
  </article>`;
}

function renderReworks() {
  const active = state.reworks.filter(Rework.isActive);
  const history = state.reworks.filter(r => !Rework.isActive(r));
  $("#reworkActive").innerHTML = active.length ? active.map(reworkCard).join("") : `<div class="empty">暂无未结束返修单</div>`;
  $("#reworkHistory").innerHTML = history.length ? history.map(reworkCard).join("") : `<div class="empty">暂无已了结返修单</div>`;
}

function renderLedger() {
  $("#batchList").innerHTML = state.batches.map(b => {
    const holds = b.holds.map(h => `${workName(h.workId)}×${h.qty}`).join("、") || "暂无占用";
    return `<div class="batch">
      <b>${b.name}</b><span class="tag">余量 ${Ledger.remaining(b)}</span>
      <div class="meta">总量 ${b.total} · 已占 ${Ledger.usedOf(b)}</div>
      <div class="meta">${holds}</div>
    </div>`;
  }).join("");
  $("#slotList").innerHTML = state.slots.map((s, i) =>
    `<div class="slot ${s.workId ? "" : "free"}"><b>${i + 1}号位</b><br>${s.workId ? workName(s.workId) : "空位"}</div>`
  ).join("");
}

function renderBoard() {
  const list = filtered();
  board.innerHTML = STATUSES.map(status => {
    const cards = list.filter(w => w.status === status);
    return `<section class="col">
      <h3><span>${status}</span><span>${cards.length}</span></h3>
      ${cards.length ? cards.map(w => {
        const rework = Rework.activeOf(state, w.id);
        return `<article class="item ${w.defect ? "overdue" : ""}" onclick="showDetail('${w.id}')">
          <b>${w.theme}</b><span class="tag">${w.status}</span>
          <div class="meta">${w.base} · ${w.line} · 进度 ${w.progress}%<br>阴干 ${w.dryDate} · 金粉 ${w.gold} · 交付 ${w.delivery}</div>
          <div class="meta">缺陷：${w.defect || "无"} · 占用：${holdText(w.id)}</div>
          ${rework ? `<div class="meta">返修单：${Rework.STATUS_LABEL[rework.status]}（${rework.type} · ${rework.reporter}）</div>` : ""}
          <div class="actions" onclick="event.stopPropagation()">
            <button class="danger" onclick="registerDefect('${w.id}', '断线')">记断线</button>
            <button class="warn" onclick="registerDefect('${w.id}', '翘线')">记翘线</button>
          </div>
          <select onclick="event.stopPropagation()" onchange="updateStatus('${w.id}', this.value)">
            ${STATUSES.map(s => `<option ${s === w.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </article>`;
      }).join("") : `<div class="empty">暂无作品</div>`}
    </section>`;
  }).join("");
}

function render() {
  renderReworks();
  renderLedger();
  renderBoard();
}

// ---- 详情弹窗：作品信息、胎体/纹样修正、领料 ----

function showDetail(id) {
  activeId = id;
  const w = byId(id);
  const rework = Rework.activeOf(state, id);
  $("#detailTitle").textContent = `${w.theme} · ${w.base}`;
  $("#detailContent").innerHTML = `
    胎体材质：${w.base}<br>纹样主题：${w.theme}<br>线条粗细：${w.line}<br>贴线进度：${w.progress}%<br>
    阴干日期：${w.dryDate}<br>金粉状态：${w.gold}<br>缺陷：${w.defect || "无"}<br>
    交付日期：${w.delivery}<br>当前状态：${w.status}<br>占用批次：${holdText(id)}<br>
    返修单：${rework ? `${Rework.STATUS_LABEL[rework.status]}（${rework.type} · 登记人 ${rework.reporter}）` : "无未结束返修单"}<br>
    备注：${w.note || "无"}<br>流转记录：${w.logs.join(" / ")}
  `;
  $("#corBase").value = w.base;
  $("#corTheme").value = w.theme;
  $("#reqBatch").innerHTML = state.batches.map(b => `<option value="${b.id}">${b.name}（余量 ${Ledger.remaining(b)}）</option>`).join("");
  $("#reqQty").value = 1;
  $("#reqBtn").disabled = !!rework;
  $("#reqHint").textContent = rework
    ? "存在未结束返修单：新的领料已阻止，已占批次维持占位"
    : "领料后计入占用账本，刷新后余量保持一致";
  if (!dialog.open) dialog.showModal();
}

$("#saveCorrection").addEventListener("click", () => {
  const w = byId(activeId);
  const base = $("#corBase").value.trim();
  const theme = $("#corTheme").value.trim();
  if (!base || !theme) return toast("胎体与纹样不能为空");
  if (base === w.base && theme === w.theme) return toast("胎体与纹样未变化");
  w.base = base;
  w.theme = theme;
  // 胎体或纹样修正让旧返修失效
  const voided = Rework.voidForCorrection(state, w.id, "胎体/纹样修正");
  if (voided) {
    w.defect = "";
    w.logs.push(`${now()} 胎体/纹样修正，旧返修单失效`);
    toast("已保存修正，旧返修单失效");
  } else {
    w.logs.push(`${now()} 胎体/纹样修正`);
    toast("已保存修正");
  }
  save();
  render();
  showDetail(activeId);
});

$("#reqBtn").addEventListener("click", () => {
  const w = byId(activeId);
  if (Rework.activeOf(state, w.id)) return toast("存在未结束返修单，已阻止新的领料；已占批次维持占位");
  const qty = Number($("#reqQty").value);
  const result = Ledger.occupy(state, w.id, $("#reqBatch").value, qty);
  if (!result.ok) return toast(result.reason);
  w.logs.push(`${now()} 领料 ${result.batch.name}×${qty}`);
  toast("领料成功，批次已占位");
  save();
  render();
  showDetail(activeId);
});

$("#closeDialog").addEventListener("click", () => dialog.close());

// ---- 表单、筛选、导出 ----

form.addEventListener("submit", event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const work = {
    id: crypto.randomUUID(),
    base: data.base,
    theme: data.theme,
    line: data.line,
    progress: Number(data.progress),
    dryDate: data.dryDate,
    gold: data.gold,
    defect: "",
    delivery: data.delivery,
    status: data.status,
    note: data.note,
    logs: [`${now()} 创建作品`]
  };
  state.works.unshift(work);
  if (work.status === "待阴干") Ledger.takeSlot(state, work.id);
  form.reset();
  form.dryDate.value = today;
  form.delivery.value = offsetDate(5);
  save();
  render();
});

operatorSelect.innerHTML = OPERATORS.map(o => `<option ${o === currentOperator ? "selected" : ""}>${o}</option>`).join("");
operatorSelect.addEventListener("change", () => {
  currentOperator = operatorSelect.value;
  localStorage.setItem(OPERATOR_KEY, currentOperator);
  render();
});

statusFilter.innerHTML = `<option value="">全部状态</option>` + STATUSES.map(s => `<option>${s}</option>`).join("");
[statusFilter, themeFilter, sortMode].forEach(el => el.addEventListener("input", render));
$("#clearFilters").addEventListener("click", () => {
  themeFilter.value = "";
  statusFilter.value = "";
  render();
});

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "lacquer-rework-station.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

window.registerDefect = registerDefect;
window.completeRework = completeRework;
window.reviewRework = reviewRework;
window.rollbackWork = rollbackWork;
window.updateStatus = updateStatus;
window.showDetail = showDetail;

form.dryDate.value = today;
form.delivery.value = offsetDate(5);
save();
render();
