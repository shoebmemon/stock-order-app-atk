const STORAGE_KEY = "shop-stock-order-app-v15";

function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function emptyState() {
  return { suppliers: [], stocks: [], order: [] };
}

let state = loadState();
const isUsingDemoData = false;
let editingSupplierId = null;
let editingStockId = null;

// ---------- Supabase sync layer ----------
const SUPABASE_URL = "https://jtaljezaydoauwcdkogo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0YWxqZXpheWRvYXV3Y2Rrb2dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MDAxNTUsImV4cCI6MjA5NzQ3NjE1NX0.0SxH9mMtJ1ze4D_ZPJUCb2PH-uVH6pui8OsX0bKOaCw";
const SYNC_QUEUE_KEY = "shop-stock-order-app-sync-queue-v1";

const sb =
  typeof window !== "undefined" && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

function supplierToDb(s) { return { id: s.id, supplier_name: s.name || "", email: s.email || null, phone: s.phone || null }; }
function supplierFromDb(row) { return { id: row.id, name: row.supplier_name || "", email: row.email || "", phone: row.phone || "" }; }
function stockToDb(item) { return { id: item.id, item_name: item.name || "", supplier_id: item.supplierId || null, unit: item.unit || null }; }
function stockFromDb(row) { return { id: row.id, name: row.item_name || "", supplierId: row.supplier_id || "", unit: row.unit || "" }; }
function orderToDb(line) {
  return { id: line.id, item_id: line.itemId || null, supplier_id: line.supplierId || null, quantity: Number(line.quantity) || 1, status: line.status || "active", batch_id: line.batchId || null, date_completed: line.dateCompleted || null };
}
function orderFromDb(row) {
  return { id: row.id, itemId: row.item_id, supplierId: row.supplier_id, quantity: Number(row.quantity) || 1, status: row.status || "active", dateCreated: row.created_at || getFormattedDate(), batchId: row.batch_id || null, dateCompleted: row.date_completed || null };
}

function loadSyncQueue() { try { const raw = localStorage.getItem(SYNC_QUEUE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; } }
function saveSyncQueue(queue) { try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue)); } catch (err) { console.warn("Could not persist sync queue:", err); } }
function enqueueSync(table, op, payload) { const queue = loadSyncQueue(); queue.push({ table, op, payload, queuedAt: Date.now() }); saveSyncQueue(queue); }

async function runSupabaseOp(table, op, payload) {
  if (!sb) throw new Error("Supabase client not available");
  if (op === "upsert") { const { error } = await sb.from(table).upsert(payload.rows); if (error) throw error; }
  else if (op === "delete") { if (!payload.ids || !payload.ids.length) return; const { error } = await sb.from(table).delete().in("id", payload.ids); if (error) throw error; }
  else if (op === "deleteWhere") {
    let query = sb.from(table).delete();
    Object.entries(payload.match || {}).forEach(([col, val]) => query = query.eq(col, val));
    if (payload.inFilter) query = query.in(payload.inFilter.column, payload.inFilter.values);
    const { error } = await query; if (error) throw error;
  } else if (op === "replaceAll") {
    const { error: delErr } = await sb.from(table).delete().not("id", "is", null); if (delErr) throw delErr;
    if (payload.rows && payload.rows.length) { const { error: insErr } = await sb.from(table).insert(payload.rows); if (insErr) throw insErr; }
  }
}

async function syncToSupabase(table, op, payload) {
  if (!sb || typeof navigator !== "undefined" && navigator.onLine === false) { enqueueSync(table, op, payload); return; }
  try { await runSupabaseOp(table, op, payload); } catch (err) { console.warn(`Supabase sync failed, queued:`, err); enqueueSync(table, op, payload); }
}

let isFlushingQueue = false;
async function flushSyncQueue() {
  if (!sb || isFlushingQueue || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  const queue = loadSyncQueue(); if (!queue.length) return;
  isFlushingQueue = true; let remaining = [...queue];
  while (remaining.length) {
    const op = remaining[0];
    try { await runSupabaseOp(op.table, op.op, op.payload); remaining.shift(); saveSyncQueue(remaining); } 
    catch (err) { break; }
  }
  isFlushingQueue = false;
}

async function pullFromSupabase() {
  if (!sb || (typeof navigator !== "undefined" && navigator.onLine === false)) return false;
  try {
    const [suppliersRes, stocksRes, ordersRes] = await Promise.all([ sb.from("suppliers").select("*"), sb.from("stocks").select("*"), sb.from("orders").select("*") ]);
    if (suppliersRes.error) throw suppliersRes.error; if (stocksRes.error) throw stocksRes.error; if (ordersRes.error) throw ordersRes.error;
    state = { suppliers: (suppliersRes.data || []).map(supplierFromDb), stocks: (stocksRes.data || []).map(stockFromDb), order: (ordersRes.data || []).map(orderFromDb) };
    saveState(); return true;
  } catch (err) { return false; }
}

async function pushAllLocalDataToSupabase() {
  if (state.suppliers.length) await syncToSupabase("suppliers", "upsert", { rows: state.suppliers.map(supplierToDb) });
  if (state.stocks.length) await syncToSupabase("stocks", "upsert", { rows: state.stocks.map(stockToDb) });
  if (state.order.length) await syncToSupabase("orders", "upsert", { rows: state.order.map(orderToDb) });
}

const INITIAL_SEED_DONE_KEY = "shop-stock-order-app-initial-seed-done-v1";
async function syncOnStartup() {
  if (!sb) return;
  await flushSyncQueue();
  const alreadySeeded = localStorage.getItem(INITIAL_SEED_DONE_KEY) === "true";
  const hasLocalData = !isUsingDemoData && (state.suppliers.length > 0 || state.stocks.length > 0 || state.order.length > 0);

  if (!alreadySeeded && hasLocalData) {
    try {
      const { count, error } = await sb.from("suppliers").select("*", { count: "exact", head: true });
      const remoteIsEmpty = !error && (count || 0) === 0;
      if (remoteIsEmpty) { await pushAllLocalDataToSupabase(); localStorage.setItem(INITIAL_SEED_DONE_KEY, "true"); return; }
    } catch (err) { return; }
  }
  localStorage.setItem(INITIAL_SEED_DONE_KEY, "true");
  const pulled = await pullFromSupabase();
  if (pulled) render();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { flushSyncQueue().then(() => pullFromSupabase().then((pulled) => { if (pulled) render(); })); });
}

let currentStatusFilter = "active"; 
let focusedSupplierId = null;
let focusedBatchId = null;
let longPressTimer = null;
let isLongPressTriggered = false;
const LONG_PRESS_DURATION = 600;
let selectedQuickOrderItem = null;

const el = {
  appShell: document.querySelector(".app-shell"),
  stockForm: document.querySelector("#stockForm"),
  supplierForm: document.querySelector("#supplierForm"),
  orderForm: document.querySelector("#orderForm"),
  stockTable: document.querySelector("#stockTable"),
  supplierList: document.querySelector("#supplierList"),
  bifurcatedOrderContainer: document.querySelector("#bifurcatedOrderContainer"),
  orderDetailsTitle: document.querySelector("#orderDetailsTitle"),
  orderDetailsSubtitle: document.querySelector("#orderDetailsSubtitle"),
  orderItemSearchInput: document.querySelector("#orderItemSearchInput"),
  hiddenOrderItemId: document.querySelector("#hiddenOrderItemId"),
  searchSuggestionsBox: document.querySelector("#searchSuggestionsBox"),
  orderQty: document.querySelector("#orderQty"),
  supplierFilter: document.querySelector("#supplierFilter"),
  supplierFilterSuggestionsBox: document.querySelector("#supplierFilterSuggestionsBox"),
  stockSearch: document.querySelector("#stockSearch"),
  recentOrderAlert: document.querySelector("#recentOrderAlert"),
  stockSubmitBtn: document.querySelector("#stockSubmitBtn"),
  stockSupplierSearchInput: document.querySelector("#stockSupplierSearchInput"),
  hiddenStockSupplierId: document.querySelector("#hiddenStockSupplierId"),
  supplierSuggestionsBox: document.querySelector("#supplierSuggestionsBox"),
  orderQtyInlineUnit: document.querySelector("#orderQtyInlineUnit"),
  pillActive: document.querySelector("#pillActive"),
  pillCompleted: document.querySelector("#pillCompleted"),
  masterView: document.querySelector("#orderDetailsMasterView"),
  deepView: document.querySelector("#orderDetailsDeepView"),
  backToMasterBtn: document.querySelector("#backToMasterBtn"),
  deepViewVendorTitle: document.querySelector("#deepViewVendorTitle"),
  deepViewDateLabel: document.querySelector("#deepViewDateLabel"),
  deepViewLinesList: document.querySelector("#deepViewLinesList"),
  toggleStatusStateBtn: document.querySelector("#toggleStatusStateBtn"),
  deepWhatsAppBtn: document.querySelector("#deepWhatsAppBtn"),
  deepEmailBtn: document.querySelector("#deepEmailBtn"),
  deepViewActionsContainer: document.querySelector("#deepViewActionsContainer"),
  bulkDeleteToolbar: document.querySelector("#bulkDeleteToolbar"),
  bulkDeleteCountLabel: document.querySelector("#bulkDeleteCountLabel"),
  bulkDeleteCancelBtn: document.querySelector("#bulkDeleteCancelBtn"),
  bulkDeleteExecuteBtn: document.querySelector("#bulkDeleteExecuteBtn"),
  masterBulkDeleteToolbar: document.querySelector("#masterBulkDeleteToolbar"),
  masterBulkDeleteCountLabel: document.querySelector("#masterBulkDeleteCountLabel"),
  masterBulkDeleteCancelBtn: document.querySelector("#masterBulkDeleteCancelBtn"),
  masterBulkDeleteExecuteBtn: document.querySelector("#masterBulkDeleteExecuteBtn"),
  pages: document.querySelectorAll(".page"),
  tabButtons: document.querySelectorAll(".tab-button:not(.tab-hidden)"),
  headerTitleView: document.querySelector("#headerTitleView"),
  headerAddStockBtn: document.querySelector("#headerAddStockBtn"),
  headerDataBtn: document.querySelector("#headerDataBtn"),
  stockPageAddItemBtn: document.querySelector("#stockPageAddItemBtn"),
  headerSelectionBar: document.querySelector("#headerSelectionBar"),
  headerSelectionCount: document.querySelector("#headerSelectionCount"),
  headerSelectionCancelBtn: document.querySelector("#headerSelectionCancelBtn"),
  headerSelectionEditBtn: document.querySelector("#headerSelectionEditBtn"),
  headerSelectionDeleteBtn: document.querySelector("#headerSelectionDeleteBtn"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportExcelBtn: document.querySelector("#exportExcelBtn"),
  exportDataBtn: document.querySelector("#exportDataBtn"),
  importDataInput: document.querySelector("#importDataInput"),
  stockSearchSuggestionsBox: document.querySelector("#stockSearchSuggestionsBox"),
  stockQuickOrderBar: document.querySelector("#stockQuickOrderBar"),
  stockQuickOrderItemName: document.querySelector("#stockQuickOrderItemName"),
  stockQuickOrderSupplierName: document.querySelector("#stockQuickOrderSupplierName"),
  stockQuickOrderQty: document.querySelector("#stockQuickOrderQty"),
  stockQuickOrderUnitLabel: document.querySelector("#stockQuickOrderUnitLabel"),
  stockQuickOrderAddBtn: document.querySelector("#stockQuickOrderAddBtn"),
  stockQuickOrderCancelBtn: document.querySelector("#stockQuickOrderCancelBtn"),
  stockQuickOrderAlert: document.querySelector("#stockQuickOrderAlert"),
  supplierSearchInput: document.querySelector("#supplierSearchInput"),
  supplierSearchSuggestionsBox: document.querySelector("#supplierSearchSuggestionsBox"),
  supplierMasterView: document.querySelector("#supplierMasterView"),
  supplierStockDetailView: document.querySelector("#supplierStockDetailView"),
  supplierStockBackBtn: document.querySelector("#supplierStockBackBtn"),
  supplierStockDetailName: document.querySelector("#supplierStockDetailName"),
  supplierStockDetailContact: document.querySelector("#supplierStockDetailContact"),
  supplierStockDetailList: document.querySelector("#supplierStockDetailList"),
  stockBulkDeleteBar: document.querySelector("#stockBulkDeleteBar"),
  stockBulkDeleteCount: document.querySelector("#stockBulkDeleteCount"),
  stockBulkDeleteCancelBtn: document.querySelector("#stockBulkDeleteCancelBtn"),
  stockBulkDeleteExecuteBtn: document.querySelector("#stockBulkDeleteExecuteBtn"),
  alreadyInListModal: document.querySelector("#alreadyInListModal"),
  alreadyInListTitle: document.querySelector("#alreadyInListTitle"),
  alreadyInListBody: document.querySelector("#alreadyInListBody"),
  alreadyInListNoBtn: document.querySelector("#alreadyInListNoBtn"),
  alreadyInListEditBtn: document.querySelector("#alreadyInListEditBtn"),
  confirmModal: document.querySelector("#confirmModal"),
  confirmModalTitle: document.querySelector("#confirmModalTitle"),
  confirmModalBody: document.querySelector("#confirmModalBody"),
  confirmModalCancelBtn: document.querySelector("#confirmModalCancelBtn"),
  confirmModalOkBtn: document.querySelector("#confirmModalOkBtn"),
  editStockModal: document.querySelector("#editStockModal"),
  editStockName: document.querySelector("#editStockName"),
  editStockSupplierSearch: document.querySelector("#editStockSupplierSearch"),
  editStockHiddenSupplierId: document.querySelector("#editStockHiddenSupplierId"),
  editStockSupplierSuggestionsBox: document.querySelector("#editStockSupplierSuggestionsBox"),
  editStockUnit: document.querySelector("#editStockUnit"),
  editStockCancelBtn: document.querySelector("#editStockCancelBtn"),
  editStockSaveBtn: document.querySelector("#editStockSaveBtn"),
  editStockQuickAddSupplierBtn: document.querySelector("#editStockQuickAddSupplierBtn"),
  quickAddSupplierBtn: document.querySelector("#quickAddSupplierBtn"),
  quickAddSupplierModal: document.querySelector("#quickAddSupplierModal"),
  quickSupplierName: document.querySelector("#quickSupplierName"),
  quickSupplierEmail: document.querySelector("#quickSupplierEmail"),
  quickSupplierPhone: document.querySelector("#quickSupplierPhone"),
  quickAddSupplierCancelBtn: document.querySelector("#quickAddSupplierCancelBtn"),
  quickAddSupplierSaveBtn: document.querySelector("#quickAddSupplierSaveBtn"),
  quickAddStockItemBtn: document.querySelector("#quickAddStockItemBtn"),
  quickAddStockItemModal: document.querySelector("#quickAddStockItemModal"),
  quickStockItemName: document.querySelector("#quickStockItemName"),
  quickStockItemUnit: document.querySelector("#quickStockItemUnit"),
  quickStockItemSupplierSearch: document.querySelector("#quickStockItemSupplierSearch"),
  quickStockItemHiddenSupplierId: document.querySelector("#quickStockItemHiddenSupplierId"),
  quickStockItemSupplierSuggestionsBox: document.querySelector("#quickStockItemSupplierSuggestionsBox"),
  quickStockItemQuickAddSupplierBtn: document.querySelector("#quickStockItemQuickAddSupplierBtn"),
  quickStockItemNewSupplierPanel: document.querySelector("#quickStockItemNewSupplierPanel"),
  quickStockItemNewSupplierName: document.querySelector("#quickStockItemNewSupplierName"),
  quickStockItemNewSupplierEmail: document.querySelector("#quickStockItemNewSupplierEmail"),
  quickStockItemNewSupplierPhone: document.querySelector("#quickStockItemNewSupplierPhone"),
  quickAddStockItemCancelBtn: document.querySelector("#quickAddStockItemCancelBtn"),
  quickAddStockItemSaveBtn: document.querySelector("#quickAddStockItemSaveBtn"),
  editSupplierModal: document.querySelector("#editSupplierModal"),
  editSupplierName: document.querySelector("#editSupplierName"),
  editSupplierEmail: document.querySelector("#editSupplierEmail"),
  editSupplierPhone: document.querySelector("#editSupplierPhone"),
  editSupplierCancelBtn: document.querySelector("#editSupplierCancelBtn"),
  editSupplierSaveBtn: document.querySelector("#editSupplierSaveBtn"),
  editQtyModal: document.querySelector("#editQtyModal"),
  editQtyModalTitle: document.querySelector("#editQtyModalTitle"),
  editQtyItemName: document.querySelector("#editQtyItemName"),
  editQtyInput: document.querySelector("#editQtyInput"),
  editQtyCancelBtn: document.querySelector("#editQtyCancelBtn"),
  editQtySaveBtn: document.querySelector("#editQtySaveBtn")
};

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return emptyState();
  try {
    const parsed = JSON.parse(saved);
    return { suppliers: parsed.suppliers || [], stocks: (parsed.stocks || []).map(normalizeStockItem), order: parsed.order || [] };
  } catch { return emptyState(); }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function supplierName(id) { return state.suppliers.find((supplier) => supplier.id === id)?.name || "No supplier"; }
function keepSelectValue(select, value) { if (select && [...select.options].some((option) => option.value === value)) select.value = value; }
function formatNumber(value) { return Number(value || 0).toLocaleString("en-IN"); }
function formatUnit(value) { return String(value || "").trim(); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function clearInlineUnitLabel() { if (el.orderQtyInlineUnit) el.orderQtyInlineUnit.textContent = ""; }

function addOrUpdateOrderLine(item, qty) {
  const quantity = Math.max(1, Number(qty) || 1);
  const existingLine = state.order.find((line) => line.itemId === item.id && (line.status || "active") === "active");
  if (existingLine) {
    existingLine.quantity = Number(existingLine.quantity || 0) + quantity;
    syncToSupabase("orders", "upsert", { rows: [orderToDb(existingLine)] });
  } else {
    const newLine = { id: generateUUID(), itemId: item.id, supplierId: item.supplierId, quantity, status: "active", dateCreated: getFormattedDate() };
    state.order.push(newLine);
    syncToSupabase("orders", "upsert", { rows: [orderToDb(newLine)] });
  }
}

function toggleActiveCompletedState(supplierId, newStatus, batchId) {
  const changedLines = [];
  if (newStatus === "completed") {
    const newBatchId = generateUUID();
    const completedDate = new Date().toISOString();
    state.order.forEach((line) => {
      if (line.supplierId === supplierId && (line.status || "active") !== "completed") {
        line.status = "completed"; line.batchId = newBatchId; line.dateCompleted = completedDate; changedLines.push(line);
      }
    });
  } else {
    state.order.forEach((line) => {
      if (line.supplierId === supplierId && (line.status || "active") === "completed" && (line.batchId || "") === (batchId || "")) {
        line.status = "active"; line.batchId = null; changedLines.push(line);
      }
    });
  }
  saveState();
  if (changedLines.length) syncToSupabase("orders", "upsert", { rows: changedLines.map(orderToDb) });
  
  resetDeepSelection();
  if (el.deepView) el.deepView.style.display = "none";
  if (el.masterView) el.masterView.style.display = "block";
  renderBifurcatedOrders();
}

function buildCleanTextPayload(supplierId) {
  const lines = state.order.filter((line) => line.supplierId === supplierId && (line.status || "active") === currentStatusFilter);
  return lines.map((line) => {
    const item = state.stocks.find((s) => s.id === line.itemId);
    return `- ${item ? item.name : "Deleted item"}: ${formatNumber(line.quantity)} ${item?.unit || "pcs"}`;
  }).join("\n");
}

document.querySelectorAll("[data-status-filter]").forEach((pill) => {
  pill.addEventListener("click", () => {
    if(el.pillActive) el.pillActive.classList.toggle("active", pill.dataset.statusFilter === "active");
    if(el.pillCompleted) el.pillCompleted.classList.toggle("active", pill.dataset.statusFilter === "completed");
    currentStatusFilter = pill.dataset.statusFilter;
    resetMasterSelection(); resetDeepSelection();
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    renderBifurcatedOrders();
  });
});

function getFormattedDate() { return new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
function formatDisplayDate(value) {
  if (!value) return getFormattedDate();
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function normalizeStockItem(item) { return { id: item.id || generateUUID(), name: item.name || "", supplierId: item.supplierId || "", unit: formatUnit(item.unit) }; }

function render() {
  renderSupplierOptions();
  renderStockTable();
  renderSupplierList();
  renderBifurcatedOrders();
}

let activeHeaderSelectionContext = null; 
function showHeaderSelection(context) {
  activeHeaderSelectionContext = context;
  if (el.headerTitleView) el.headerTitleView.style.display = "none";
  if (el.headerSelectionBar) el.headerSelectionBar.style.display = "flex";
}
function hideHeaderSelection() {
  activeHeaderSelectionContext = null;
  if (el.headerTitleView) el.headerTitleView.style.display = "flex";
  if (el.headerSelectionBar) el.headerSelectionBar.style.display = "none";
  hideHeaderSelectionEditBtn(); resetSupplierSelectionState();
}
function setHeaderSelectionCount(text) { if (el.headerSelectionCount) el.headerSelectionCount.textContent = text; }
function showHeaderSelectionEditBtn(id) {
  if (!el.headerSelectionEditBtn) return;
  el.headerSelectionEditBtn.style.display = "inline-flex"; el.headerSelectionEditBtn.dataset.editId = id;
}
function hideHeaderSelectionEditBtn() {
  if (!el.headerSelectionEditBtn) return;
  el.headerSelectionEditBtn.style.display = "none"; delete el.headerSelectionEditBtn.dataset.editId;
}

if (el.headerSelectionCancelBtn) {
  el.headerSelectionCancelBtn.addEventListener("click", () => {
    if (activeHeaderSelectionContext === "stock" && el.stockBulkDeleteCancelBtn) el.stockBulkDeleteCancelBtn.click();
    else if (activeHeaderSelectionContext === "master" && el.masterBulkDeleteCancelBtn) el.masterBulkDeleteCancelBtn.click();
    else if (activeHeaderSelectionContext === "deep" && el.bulkDeleteCancelBtn) el.bulkDeleteCancelBtn.click();
    else if (activeHeaderSelectionContext === "supplier") clearSupplierHeaderSelection();
    hideHeaderSelection();
  });
}
if (el.headerSelectionEditBtn) {
  el.headerSelectionEditBtn.addEventListener("click", () => {
    const id = el.headerSelectionEditBtn.dataset.editId; if (!id) return;
    if (activeHeaderSelectionContext === "stock") { const item = state.stocks.find((s) => s.id === id); if (item) openEditStockModal(item); }
    else if (activeHeaderSelectionContext === "supplier") { const supplier = state.suppliers.find((s) => s.id === id); if (supplier) openEditSupplierModal(supplier); }
  });
}
if (el.headerSelectionDeleteBtn) {
  el.headerSelectionDeleteBtn.addEventListener("click", () => {
    if (activeHeaderSelectionContext === "stock" && el.stockBulkDeleteExecuteBtn) el.stockBulkDeleteExecuteBtn.click();
    else if (activeHeaderSelectionContext === "master" && el.masterBulkDeleteExecuteBtn) el.masterBulkDeleteExecuteBtn.click();
    else if (activeHeaderSelectionContext === "deep" && el.bulkDeleteExecuteBtn) el.bulkDeleteExecuteBtn.click();
    else if (activeHeaderSelectionContext === "supplier" && supplierSelectedIds.size) requestDeleteSuppliers([...supplierSelectedIds]);
  });
}

function showPage(pageId, fromPopState = false) {
  el.pages.forEach((page) => {
    const isActive = page.id === pageId;
    page.hidden = !isActive;
    page.classList.toggle("active", isActive);
  });

  el.tabButtons.forEach((button) => {
    const isActive = button.dataset.pageTarget === pageId && (!button.dataset.statusFilter || button.dataset.statusFilter === currentStatusFilter);
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  hideHeaderSelection();
  hideStockBulkDeleteBar();
  resetMasterSelection();
  resetDeepSelection();

  // Hide any open deep views to ensure a clean slate
  if (el.deepView) el.deepView.style.display = "none";
  if (el.masterView) el.masterView.style.display = "block";
  focusedSupplierDetailId = null;
  if (el.supplierStockDetailView) el.supplierStockDetailView.style.display = "none";
  if (el.supplierMasterView) el.supplierMasterView.style.display = "block";

  if (pageId === "orderDetailsPage") renderBifurcatedOrders();

  if (!fromPopState) {
    history.replaceState({ isAppOpen: true }, "", `#${pageId}`);
  }
}

function renderSupplierOptions() { }

function renderStockTable() {
  if (!el.stockTable || !el.stockSearch || !el.supplierFilter) return;
  const query = el.stockSearch.value.trim().toLowerCase();
  const supplierQuery = el.supplierFilter.value.trim().toLowerCase();
  const visibleStocks = state.stocks.filter((item) => {
    const sName = supplierName(item.supplierId).toLowerCase();
    const matchesQuery = [item.name, sName].join(" ").toLowerCase().includes(query);
    const matchesSupplier = !supplierQuery || sName.includes(supplierQuery);
    return matchesQuery && matchesSupplier;
  }).sort((a, b) => a.name.localeCompare(b.name));

  if (!visibleStocks.length) {
    el.stockTable.innerHTML = `<tr><td colspan="3" class="empty">No stock items found.</td></tr>`;
    return;
  }
  el.stockTable.innerHTML = visibleStocks.map((item) => `
      <tr class="stock-table-row" data-item-id="${item.id}" style="cursor: pointer; user-select: none; -webkit-user-select: none;">
        <td data-label="Item"><div class="item-name">${escapeHtml(item.name)}</div></td>
        <td data-label="Supplier">${escapeHtml(supplierName(item.supplierId))}</td>
        <td data-label="Unit">${escapeHtml(item.unit || "pcs")}</td>
      </tr>
    `).join("");
  setupStockTableLongPress();
}

let stockTableLongPressTimer = null;
let stockTableSelectionActive = false;
let stockSelectedIds = new Set();
function setupStockTableLongPress() {
  el.stockTable.querySelectorAll(".stock-table-row").forEach((row) => {
    const onLongPress = () => {
      stockTableSelectionActive = true; showStockBulkDeleteBar(); stockSelectedIds.add(row.dataset.itemId);
      row.classList.add("row-selected"); updateStockBulkDeleteBar();
      if (navigator.vibrate) navigator.vibrate(50);
    };
    let touchStartX = 0, touchStartY = 0;
    row.addEventListener("mousedown", (e) => { if (e.target.closest("button")) return; stockTableLongPressTimer = setTimeout(onLongPress, 600); });
    row.addEventListener("touchstart", (e) => {
      if (e.target.closest("button")) return;
      touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; stockTableLongPressTimer = setTimeout(onLongPress, 600);
    }, { passive: true });
    row.addEventListener("touchmove", (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX); const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 8 || dy > 8) clearTimeout(stockTableLongPressTimer);
    }, { passive: true });
    row.addEventListener("mouseup", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("touchend", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("touchcancel", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("mouseleave", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (stockTableSelectionActive) {
        const id = row.dataset.itemId;
        if (stockSelectedIds.has(id)) { stockSelectedIds.delete(id); row.classList.remove("row-selected"); } 
        else { stockSelectedIds.add(id); row.classList.add("row-selected"); }
        updateStockBulkDeleteBar(); return;
      }
      const item = state.stocks.find((s) => s.id === row.dataset.itemId);
      if (item) openEditStockModal(item);
    });
  });
}

function showStockBulkDeleteBar() { if (!el.stockBulkDeleteBar) return; el.stockBulkDeleteBar.style.display = "flex"; showHeaderSelection("stock"); }
function hideStockBulkDeleteBar() {
  stockTableSelectionActive = false; stockSelectedIds.clear();
  if (el.stockTable) el.stockTable.querySelectorAll(".stock-table-row.row-selected").forEach((r) => r.classList.remove("row-selected"));
  if (!el.stockBulkDeleteBar) return; el.stockBulkDeleteBar.style.display = "none";
  if (el.stockBulkDeleteCount) el.stockBulkDeleteCount.textContent = "0 selected";
  hideHeaderSelection();
}
function updateStockBulkDeleteBar() {
  const checked = stockSelectedIds.size; const countText = `${checked} selected`;
  if (el.stockBulkDeleteCount) el.stockBulkDeleteCount.textContent = countText; setHeaderSelectionCount(countText);
  if (checked === 0) { hideStockBulkDeleteBar(); return; }
  if (checked === 1) showHeaderSelectionEditBtn([...stockSelectedIds][0]); else hideHeaderSelectionEditBtn();
}

let focusedSupplierDetailId = null;

function openSupplierStockDetail(supplierId) {
  focusedSupplierDetailId = supplierId;
  const supplier = state.suppliers.find(s => s.id === supplierId);
  if (!supplier) return;

  // History API - Register the overlay in the back stack
  history.pushState({ isAppOpen: true, isDeepView: true }, "", location.hash + "-detail");

  if (el.supplierMasterView) el.supplierMasterView.style.display = "none";
  if (el.supplierStockDetailView) el.supplierStockDetailView.style.display = "block";
  if (el.supplierStockDetailName) el.supplierStockDetailName.textContent = supplier.name;
  if (el.supplierStockDetailContact) {
    const contact = [supplier.phone, supplier.email].filter(Boolean).join(" · ");
    el.supplierStockDetailContact.textContent = contact || "No contact info";
  }
  renderSupplierStockDetail();
}

function renderSupplierStockDetail() {
  if (!el.supplierStockDetailList || !focusedSupplierDetailId) return;
  const items = state.stocks.filter(s => s.supplierId === focusedSupplierDetailId).sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) {
    el.supplierStockDetailList.innerHTML = `<div class="empty">No stock items linked to this supplier yet.<br>Go to Order List and tap the + button to add some.</div>`; return;
  }
  el.supplierStockDetailList.innerHTML = items.map(item => `
    <div class="supplier-stock-item" data-item-id="${item.id}" style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; margin-bottom: 6px; cursor: pointer; user-select: none; -webkit-user-select: none; overflow: hidden;">
      <div style="flex: 1 1 0; min-width: 0;">
        <strong style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.95rem;">${escapeHtml(item.name)}</strong>
        <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(item.unit || "pcs")}</span>
      </div>
      <span style="flex-shrink: 0; color: var(--primary); font-size: 1rem;">➕</span>
    </div>
  `).join("");
  setupSupplierStockDetailLongPress();
}

let supplierStockDetailLongPressTimer = null;
function setupSupplierStockDetailLongPress() {
  if (!el.supplierStockDetailList) return;
  el.supplierStockDetailList.querySelectorAll(".supplier-stock-item").forEach((row) => {
    const start = () => {
      cancelSupplierStockDetailLongPress(); isLongPressTriggered = false;
      supplierStockDetailLongPressTimer = setTimeout(() => {
        isLongPressTriggered = true;
        const stock = state.stocks.find(s => s.id === row.dataset.itemId);
        if (stock) openEditStockModal(stock);
        if (navigator.vibrate) navigator.vibrate(50);
      }, LONG_PRESS_DURATION);
    };
    row.addEventListener("mousedown", start); row.addEventListener("mouseup", cancelSupplierStockDetailLongPress); row.addEventListener("mouseleave", cancelSupplierStockDetailLongPress);
    let touchStartX = 0, touchStartY = 0;
    row.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; start(); }, { passive: true });
    row.addEventListener("touchmove", (e) => { const dx = Math.abs(e.touches[0].clientX - touchStartX); const dy = Math.abs(e.touches[0].clientY - touchStartY); if (dx > 8 || dy > 8) cancelSupplierStockDetailLongPress(); }, { passive: true });
    row.addEventListener("touchend", cancelSupplierStockDetailLongPress); row.addEventListener("touchcancel", cancelSupplierStockDetailLongPress);
  });
}
function cancelSupplierStockDetailLongPress() { if (supplierStockDetailLongPressTimer) clearTimeout(supplierStockDetailLongPressTimer); }

function closeSupplierStockDetail() {
  focusedSupplierDetailId = null;
  if (el.supplierStockDetailView) el.supplierStockDetailView.style.display = "none";
  if (el.supplierMasterView) el.supplierMasterView.style.display = "block";
}

function renderSupplierList() {
  if (!el.supplierList) return;
  if (activeHeaderSelectionContext === "supplier") hideHeaderSelection(); else resetSupplierSelectionState();
  if (!state.suppliers.length) { el.supplierList.innerHTML = `<div class="empty">No suppliers yet. Go to Order List and tap the + button to add one.</div>`; return; }

  const query = (el.supplierSearchInput?.value || "").trim().toLowerCase();
  const visibleSuppliers = (query ? state.suppliers.filter((supplier) => supplier.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));

  if (!visibleSuppliers.length) { el.supplierList.innerHTML = `<div class="empty">No suppliers match your search.</div>`; return; }

  el.supplierList.innerHTML = visibleSuppliers.map((supplier) => `
        <div class="supplier-card-row" data-supplier-id="${supplier.id}" style="display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: #fff; margin-bottom: 6px; cursor: pointer; user-select: none; -webkit-user-select: none; overflow: hidden;">
          <div style="flex: 1 1 0; min-width: 0; overflow: hidden;">
            <strong style="font-size: 1rem; display: block; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(supplier.name)}</strong>
            <div style="font-size: 0.82rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${supplier.phone ? escapeHtml(supplier.phone) : (supplier.email ? escapeHtml(supplier.email) : "No contact info")}</div>
          </div>
          <div style="flex-shrink: 0; display: flex; align-items: center; gap: 6px;"><span style="color: var(--primary); font-size: 1.2rem; line-height: 1; padding-left: 4px;">›</span></div>
        </div>
      `).join("");
  setupSupplierLongPressTriggers();
}

function handleSearchInput() {
  if (!el.orderItemSearchInput || !el.searchSuggestionsBox) return;
  const query = el.orderItemSearchInput.value.trim().toLowerCase();
  const matches = (query ? state.stocks.filter((item) => item.name.toLowerCase().includes(query) || supplierName(item.supplierId).toLowerCase().includes(query)) : [...state.stocks]).sort((a, b) => a.name.localeCompare(b.name));

  if (!state.stocks.length) { el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No stock items added yet. Tap the + button to add one.</div>`; el.searchSuggestionsBox.style.display = "block"; return; }
  if (!matches.length) { el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No items match "${escapeHtml(query)}"</div>`; el.searchSuggestionsBox.style.display = "block"; return; }

  el.searchSuggestionsBox.innerHTML = matches.map((item) => `
      <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong><span class="vendor-tag">${escapeHtml(supplierName(item.supplierId))}</span>
      </div>
    `).join("");
  el.searchSuggestionsBox.style.display = "block";
}

let supplierLongPressTimer = null;
let supplierSelectionActive = false;
let supplierSelectedIds = new Set();
function setupSupplierLongPressTriggers() {
  if (!el.supplierList) return;
  el.supplierList.querySelectorAll(".supplier-card-row").forEach((row) => {
    row.addEventListener("mousedown", (e) => startSupplierLongPress(e, row)); row.addEventListener("mouseup", cancelSupplierLongPress); row.addEventListener("mouseleave", cancelSupplierLongPress);
    let supplierTouchStartX = 0, supplierTouchStartY = 0;
    row.addEventListener("touchstart", (e) => { supplierTouchStartX = e.touches[0].clientX; supplierTouchStartY = e.touches[0].clientY; startSupplierLongPress(e, row); }, { passive: true });
    row.addEventListener("touchmove", (e) => { const dx = Math.abs(e.touches[0].clientX - supplierTouchStartX); const dy = Math.abs(e.touches[0].clientY - supplierTouchStartY); if (dx > 8 || dy > 8) cancelSupplierLongPress(); }, { passive: true });
    row.addEventListener("touchend", cancelSupplierLongPress); row.addEventListener("touchcancel", cancelSupplierLongPress);
  });
}
function startSupplierLongPress(e, row) {
  cancelSupplierLongPress(); isLongPressTriggered = false;
  supplierLongPressTimer = setTimeout(() => {
    isLongPressTriggered = true; supplierSelectionActive = true; supplierSelectedIds.add(row.dataset.supplierId); row.classList.add("row-selected");
    updateSupplierHeaderSelection(); if (navigator.vibrate) navigator.vibrate(50);
  }, LONG_PRESS_DURATION);
}
function cancelSupplierLongPress() { if (supplierLongPressTimer) clearTimeout(supplierLongPressTimer); }

function updateSupplierHeaderSelection() {
  const count = supplierSelectedIds.size;
  if (count === 0) { clearSupplierHeaderSelection(); return; }
  showHeaderSelection("supplier");
  if (count === 1) { const supplier = state.suppliers.find((s) => s.id === [...supplierSelectedIds][0]); setHeaderSelectionCount(supplier ? supplier.name : "1 selected"); showHeaderSelectionEditBtn([...supplierSelectedIds][0]); } 
  else { setHeaderSelectionCount(`${count} suppliers selected`); hideHeaderSelectionEditBtn(); }
}
function resetSupplierSelectionState() {
  supplierSelectionActive = false; supplierSelectedIds.clear();
  if (el.supplierList) el.supplierList.querySelectorAll(".supplier-card-row.row-selected").forEach((r) => r.classList.remove("row-selected"));
}
function clearSupplierHeaderSelection() { resetSupplierSelectionState(); hideHeaderSelection(); }

async function requestDeleteSuppliers(ids) {
  if (!ids.length) return;
  const blocked = []; const needsStockCleanup = []; const deletable = [];
  ids.forEach((id) => {
    const supplier = state.suppliers.find((s) => s.id === id); if (!supplier) return;
    const supplierStockIds = state.stocks.filter((s) => s.supplierId === id).map((s) => s.id);
    const inOrders = supplierStockIds.some((stockId) => state.order.some((line) => line.itemId === stockId));
    if (inOrders) blocked.push(supplier.name); else if (supplierStockIds.length) needsStockCleanup.push(supplier.name); else deletable.push(id);
  });

  if (blocked.length || needsStockCleanup.length) {
    const parts = [];
    if (blocked.length) parts.push(`${blocked.join(", ")} — still ${blocked.length === 1 ? "has" : "have"} stock items present in your Active or Completed orders. Remove ${blocked.length === 1 ? "it" : "them"} from your orders first.`);
    if (needsStockCleanup.length) parts.push(`${needsStockCleanup.join(", ")} — still ${needsStockCleanup.length === 1 ? "has" : "have"} stock items linked. Delete ${needsStockCleanup.length === 1 ? "that item" : "those items"} from Stock Details first.`);
    const deletableNote = deletable.length ? `\n\n${deletable.length} of your selected supplier${deletable.length === 1 ? "" : "s"} can be deleted now — the rest cannot yet:\n\n` : "\n\nNone of the selected suppliers can be deleted yet:\n\n";
    await showConfirm("Some Suppliers Can't Be Deleted", deletableNote + parts.join("\n\n"), "OK", false);
    if (!deletable.length) return;
    if (!await showConfirm("Delete Supplier" + (deletable.length === 1 ? "" : "s"), `Delete ${deletable.length} supplier${deletable.length === 1 ? "" : "s"} that ${deletable.length === 1 ? "has" : "have"} no linked stock items? This cannot be undone.`)) return;
  } else {
    if (!await showConfirm("Delete Supplier" + (deletable.length === 1 ? "" : "s"), deletable.length === 1 ? `Delete "${state.suppliers.find((s) => s.id === deletable[0])?.name}"? This cannot be undone.` : `Delete ${deletable.length} selected suppliers? This cannot be undone.`)) return;
  }
  state.suppliers = state.suppliers.filter((s) => !deletable.includes(s.id));
  saveState(); syncToSupabase("suppliers", "delete", { ids: deletable }); clearSupplierHeaderSelection(); render();
}

if (el.supplierList) {
  el.supplierList.addEventListener("click", (event) => {
    if (isLongPressTriggered) { isLongPressTriggered = false; return; }
    const row = event.target.closest(".supplier-card-row"); if (!row) return;
    if (supplierSelectionActive) {
      const id = row.dataset.supplierId;
      if (supplierSelectedIds.has(id)) { supplierSelectedIds.delete(id); row.classList.remove("row-selected"); } 
      else { supplierSelectedIds.add(id); row.classList.add("row-selected"); }
      updateSupplierHeaderSelection(); return;
    }
    openSupplierStockDetail(row.dataset.supplierId);
  });
}

// Intercepts the back button so it handles native back gesture safely
if (el.supplierStockBackBtn) {
  el.supplierStockBackBtn.addEventListener("click", () => history.back());
}

if (el.supplierStockDetailList) {
  el.supplierStockDetailList.addEventListener("click", (event) => {
    if (isLongPressTriggered) { isLongPressTriggered = false; return; }
    const item = event.target.closest(".supplier-stock-item"); if (!item) return;
    const stock = state.stocks.find(s => s.id === item.dataset.itemId); if (stock) openAddToOrderModal(stock);
  });
}

function handleStockSupplierSearch() {
  if (!el.stockSupplierSearchInput || !el.supplierSuggestionsBox) return;
  const query = el.stockSupplierSearchInput.value.trim().toLowerCase();
  const matches = (query ? state.suppliers.filter((supplier) => supplier.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));
  if (!state.suppliers.length) { el.supplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers added yet. Go to Supplier Details to add one.</div>`; el.supplierSuggestionsBox.style.display = "block"; return; }
  if (!matches.length) { el.supplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers match "${escapeHtml(query)}"</div>`; el.supplierSuggestionsBox.style.display = "block"; return; }
  el.supplierSuggestionsBox.innerHTML = matches.map((supplier) => `<div class="supplier-suggestion-item suggestion-item" data-id="${supplier.id}" data-name="${escapeHtml(supplier.name)}"><strong>${escapeHtml(supplier.name)}</strong></div>`).join("");
  el.supplierSuggestionsBox.style.display = "block";
}

function handleSupplierListSearch() {
  if (!el.supplierSearchInput || !el.supplierSearchSuggestionsBox) return;
  const query = el.supplierSearchInput.value.trim().toLowerCase();
  const matches = (query ? state.suppliers.filter(s => s.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));
  if (!state.suppliers.length) { el.supplierSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers added yet.</div>`; el.supplierSearchSuggestionsBox.style.display = "block"; return; }
  if (!matches.length) { el.supplierSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers match "${escapeHtml(query)}"</div>`; el.supplierSearchSuggestionsBox.style.display = "block"; return; }
  el.supplierSearchSuggestionsBox.innerHTML = matches.map((supplier) => `<div class="suggestion-item" data-id="${supplier.id}" data-name="${escapeHtml(supplier.name)}"><strong>${escapeHtml(supplier.name)}</strong></div>`).join("");
  el.supplierSearchSuggestionsBox.style.display = "block";
}

function handleStockSearchInput() {
  if (!el.stockSearch || !el.stockSearchSuggestionsBox) return;
  const query = el.stockSearch.value.trim().toLowerCase();
  const matches = (query ? state.stocks.filter((item) => item.name.toLowerCase().includes(query) || supplierName(item.supplierId).toLowerCase().includes(query)) : [...state.stocks]).sort((a, b) => a.name.localeCompare(b.name));
  if (!state.stocks.length) { el.stockSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No stock items added yet.</div>`; el.stockSearchSuggestionsBox.style.display = "block"; return; }
  if (!matches.length) { el.stockSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No items match "${escapeHtml(query)}"</div>`; el.stockSearchSuggestionsBox.style.display = "block"; return; }
  el.stockSearchSuggestionsBox.innerHTML = matches.map((item) => `<div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}"><strong>${escapeHtml(item.name)}</strong><span class="vendor-tag">${escapeHtml(supplierName(item.supplierId))}</span></div>`).join("");
  el.stockSearchSuggestionsBox.style.display = "block";
}

function selectQuickOrderItem(item) {
  selectedQuickOrderItem = item;
  if (el.stockSearch) el.stockSearch.value = item.name;
  renderStockTable();
  if (el.stockQuickOrderBar) el.stockQuickOrderBar.style.display = "flex";
  if (el.stockQuickOrderItemName) el.stockQuickOrderItemName.textContent = item.name;
  if (el.stockQuickOrderSupplierName) el.stockQuickOrderSupplierName.textContent = supplierName(item.supplierId);
  if (el.stockQuickOrderUnitLabel) el.stockQuickOrderUnitLabel.textContent = item.unit || "pcs";
  if (el.stockQuickOrderQty) { el.stockQuickOrderQty.value = 1; el.stockQuickOrderQty.focus(); el.stockQuickOrderQty.select(); }
}
function clearQuickOrderBar() {
  selectedQuickOrderItem = null;
  if (el.stockQuickOrderBar) el.stockQuickOrderBar.style.display = "none";
  if (el.stockQuickOrderQty) el.stockQuickOrderQty.value = 1;
}

function renderBifurcatedOrders() {
  if (!el.bifurcatedOrderContainer) return;
  if (el.masterBulkDeleteToolbar) el.masterBulkDeleteToolbar.style.display = "none";
  if (el.masterView) el.masterView.classList.remove("selection-active");
  hideHeaderSelection();
  el.bifurcatedOrderContainer.classList.remove("status-active", "status-completed");
  el.bifurcatedOrderContainer.classList.add(currentStatusFilter === "completed" ? "status-completed" : "status-active");
  if (el.orderDetailsTitle) el.orderDetailsTitle.textContent = currentStatusFilter === "completed" ? "Completed" : "Active";
  if (el.orderDetailsSubtitle) el.orderDetailsSubtitle.textContent = currentStatusFilter === "completed" ? "Your completed orders." : "Your active orders.";
  const rowIcon = currentStatusFilter === "completed"
    ? `<svg class="row-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><polyline points="8.5 12.5 11 15 15.5 9.5" /></svg>`
    : `<svg class="row-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></svg>`;
  const targetLines = state.order.filter((line) => (line.status || "active") === currentStatusFilter);
  if (!targetLines.length) { el.bifurcatedOrderContainer.innerHTML = `<div class="empty">No ${currentStatusFilter} orders currently in register logs.</div>`; return; }

  if (currentStatusFilter === "completed") {
    const groups = new Map();
    targetLines.forEach((line) => {
      const batchKey = line.batchId || ""; const groupKey = `${line.supplierId}::${batchKey}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { supplierId: line.supplierId, batchId: batchKey, lines: [] });
      groups.get(groupKey).lines.push(line);
    });
    const sortedGroups = [...groups.values()].sort((a, b) => new Date(b.lines[0].dateCompleted || b.lines[0].dateCreated || 0).getTime() - new Date(a.lines[0].dateCompleted || a.lines[0].dateCreated || 0).getTime());
    el.bifurcatedOrderContainer.innerHTML = sortedGroups.map(({ supplierId: sId, batchId, lines }) => {
      const vendorLabel = supplierName(sId); const dateLabel = formatDisplayDate(lines[0].dateCompleted || lines[0].dateCreated);
      return `<div class="single-line-row" data-supplier-id="${sId}" data-batch-id="${escapeHtml(batchId)}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0;">
          <div class="vendor-title-wrapper">${rowIcon}<div style="display: flex; flex-direction: column; min-width: 0; overflow: hidden;"><span class="vendor-title">${escapeHtml(vendorLabel)}</span><span class="subtle" style="font-size: 0.78rem;">${escapeHtml(dateLabel)}</span></div></div>
          <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0;"><span class="badge-count">${lines.length} Item${lines.length === 1 ? '' : 's'}</span></div>
        </div>`;
    }).join("");
    setupMasterLongPressTriggers(); return;
  }

  const uniqueSuppliers = [...new Set(targetLines.map(line => line.supplierId))];
  el.bifurcatedOrderContainer.innerHTML = uniqueSuppliers.map((sId) => {
    const vendorLabel = supplierName(sId); const supplierLines = targetLines.filter(line => line.supplierId === sId);
    const sLinesCount = supplierLines.length; const latestDate = supplierLines.reduce((latest, line) => { const t = new Date(line.dateCreated || 0).getTime(); return t > latest ? t : latest; }, 0);
    const dateLabel = latestDate ? formatDisplayDate(new Date(latestDate).toISOString()) : formatDisplayDate();
    return `<div class="single-line-row" data-supplier-id="${sId}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0;">
        <div class="vendor-title-wrapper">${rowIcon}<div style="display: flex; flex-direction: column; min-width: 0; overflow: hidden;"><span class="vendor-title">${escapeHtml(vendorLabel)}</span><span class="subtle" style="font-size: 0.78rem;">Added ${escapeHtml(dateLabel)}</span></div></div>
        <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0;"><span class="badge-count">${sLinesCount} Item${sLinesCount === 1 ? '' : 's'}</span></div>
      </div>`;
  }).join("");
  setupMasterLongPressTriggers();
}

let masterSelectedKeys = new Set();
function masterRowKey(row) { return `${row.dataset.supplierId}::${row.dataset.batchId || ""}`; }
function setupMasterLongPressTriggers() {
  el.bifurcatedOrderContainer.querySelectorAll(".single-line-row").forEach(row => {
    row.addEventListener("mousedown", (e) => startMasterLongPress(e, row)); row.addEventListener("mouseup", cancelMasterLongPress); row.addEventListener("mouseleave", cancelMasterLongPress);
    let masterTouchStartX = 0, masterTouchStartY = 0;
    row.addEventListener("touchstart", (e) => { masterTouchStartX = e.touches[0].clientX; masterTouchStartY = e.touches[0].clientY; startMasterLongPress(e, row); }, { passive: true });
    row.addEventListener("touchmove", (e) => { const dx = Math.abs(e.touches[0].clientX - masterTouchStartX); const dy = Math.abs(e.touches[0].clientY - masterTouchStartY); if (dx > 8 || dy > 8) cancelMasterLongPress(); }, { passive: true });
    row.addEventListener("touchend", cancelMasterLongPress); row.addEventListener("touchcancel", cancelMasterLongPress);
  });
}
function startMasterLongPress(e, row) {
  isLongPressTriggered = false;
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true; if (el.masterView) el.masterView.classList.add("selection-active");
    const key = masterRowKey(row); masterSelectedKeys.add(key); row.classList.add("row-selected");
    updateMasterBulkDeleteToolbarState(); if (navigator.vibrate) navigator.vibrate(50); 
  }, LONG_PRESS_DURATION);
}
function cancelMasterLongPress() { if (longPressTimer) clearTimeout(longPressTimer); }
function resetMasterSelection() {
  masterSelectedKeys.clear();
  if (el.bifurcatedOrderContainer) el.bifurcatedOrderContainer.querySelectorAll(".single-line-row.row-selected").forEach(r => r.classList.remove("row-selected"));
  if (el.masterView) el.masterView.classList.remove("selection-active");
  if (el.masterBulkDeleteToolbar) el.masterBulkDeleteToolbar.style.display = "none";
}

if (el.bifurcatedOrderContainer) {
  el.bifurcatedOrderContainer.addEventListener("click", (event) => {
    if (isLongPressTriggered) { isLongPressTriggered = false; return; }
    if (el.masterView && el.masterView.classList.contains("selection-active")) {
      const targetRow = event.target.closest(".single-line-row");
      if (targetRow) {
        const key = masterRowKey(targetRow);
        if (masterSelectedKeys.has(key)) { masterSelectedKeys.delete(key); targetRow.classList.remove("row-selected"); } 
        else { masterSelectedKeys.add(key); targetRow.classList.add("row-selected"); }
        updateMasterBulkDeleteToolbarState();
      }
      return;
    }
    const targetRow = event.target.closest(".single-line-row"); if (!targetRow) return;
    openSupplierDeepView(targetRow.dataset.supplierId, targetRow.dataset.batchId);
  });
}

let deepSelectedIds = new Set();
function setupDeepViewLongPressTriggers() {
  el.deepViewLinesList.querySelectorAll(".order-card").forEach(card => {
    card.addEventListener("mousedown", (e) => startDeepLongPress(e, card)); card.addEventListener("mouseup", cancelDeepLongPress); card.addEventListener("mouseleave", cancelDeepLongPress);
    let deepTouchStartX = 0, deepTouchStartY = 0;
    card.addEventListener("touchstart", (e) => { deepTouchStartX = e.touches[0].clientX; deepTouchStartY = e.touches[0].clientY; startDeepLongPress(e, card); }, { passive: true });
    card.addEventListener("touchmove", (e) => { const dx = Math.abs(e.touches[0].clientX - deepTouchStartX); const dy = Math.abs(e.touches[0].clientY - deepTouchStartY); if (dx > 8 || dy > 8) cancelDeepLongPress(); }, { passive: true });
    card.addEventListener("touchend", cancelDeepLongPress); card.addEventListener("touchcancel", cancelDeepLongPress);
  });
}
function startDeepLongPress(e, card) {
  if (currentStatusFilter !== 'active') return; if (e.target.closest('button[data-action]')) return;
  isLongPressTriggered = false;
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true; if (el.deepView) el.deepView.classList.add("selection-active");
    deepSelectedIds.add(card.dataset.lineId); card.classList.add("row-selected"); updateBulkDeleteToolbarState();
    if (navigator.vibrate) navigator.vibrate(50);
  }, LONG_PRESS_DURATION);
}
function cancelDeepLongPress() { if (longPressTimer) clearTimeout(longPressTimer); }
function resetDeepSelection() {
  deepSelectedIds.clear();
  if (el.deepViewLinesList) el.deepViewLinesList.querySelectorAll(".order-card.row-selected").forEach(c => c.classList.remove("row-selected"));
  if (el.deepView) el.deepView.classList.remove("selection-active");
  if (el.bulkDeleteToolbar) el.bulkDeleteToolbar.style.display = "none";
}

if (el.deepViewLinesList) {
  el.deepViewLinesList.addEventListener("click", (event) => {
    if (isLongPressTriggered) { isLongPressTriggered = false; return; }
    if (!el.deepView || !el.deepView.classList.contains("selection-active")) return;
    const card = event.target.closest(".order-card"); if (!card) return;
    const lineId = card.dataset.lineId;
    if (deepSelectedIds.has(lineId)) { deepSelectedIds.delete(lineId); card.classList.remove("row-selected"); } 
    else { deepSelectedIds.add(lineId); card.classList.add("row-selected"); }
    updateBulkDeleteToolbarState();
  });
}

let editingQtyLineId = null;   
let addingOrderItemId = null;  
let alreadyInListLineId = null; 

function openAddToOrderModal(item) {
  const existingLine = state.order.find((l) => l.itemId === item.id && (l.status || "active") === "active");
  if (existingLine) {
    alreadyInListLineId = existingLine.id;
    if (el.alreadyInListTitle) el.alreadyInListTitle.textContent = "Already in Order";
    if (el.alreadyInListBody) {
      el.alreadyInListBody.innerHTML = `<strong>${escapeHtml(item.name)}</strong> is already in your active order list.<br><br>Current quantity: <strong>${existingLine.quantity} ${escapeHtml(item.unit || "pcs")}</strong><br><br>Would you like to edit the quantity?`;
    }
    if (el.alreadyInListModal) el.alreadyInListModal.style.display = "flex"; return;
  }
  editingQtyLineId = null; addingOrderItemId = item.id;
  if (el.editQtyModalTitle) el.editQtyModalTitle.textContent = "Add to Order";
  if (el.editQtySaveBtn) el.editQtySaveBtn.textContent = "Add";
  if (el.editQtyItemName) el.editQtyItemName.textContent = `${item.name} (${item.unit || "pcs"})`;
  if (el.editQtyInput) el.editQtyInput.value = 1;
  if (el.editQtyModal) el.editQtyModal.style.display = "flex";
  setTimeout(() => { if (el.editQtyInput) { el.editQtyInput.focus(); el.editQtyInput.select(); } }, 50);
}

let _confirmResolve = null;
function showConfirm(title, body, okLabel = "Delete", okDanger = true) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    if (el.confirmModalTitle) el.confirmModalTitle.textContent = title;
    if (el.confirmModalBody) el.confirmModalBody.textContent = body;
    if (el.confirmModalOkBtn) { el.confirmModalOkBtn.textContent = okLabel; el.confirmModalOkBtn.style.background = okDanger ? "var(--danger)" : "var(--primary)"; }
    if (el.confirmModal) el.confirmModal.style.display = "flex";
  });
}
function _closeConfirmModal(result) {
  if (el.confirmModal) el.confirmModal.style.display = "none";
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

if (el.confirmModalOkBtn) el.confirmModalOkBtn.addEventListener("click", () => _closeConfirmModal(true));
if (el.confirmModalCancelBtn) el.confirmModalCancelBtn.addEventListener("click", () => _closeConfirmModal(false));
if (el.confirmModal) el.confirmModal.addEventListener("click", (e) => { if (e.target === el.confirmModal) _closeConfirmModal(false); });

function closeAlreadyInListModal() { alreadyInListLineId = null; if (el.alreadyInListModal) el.alreadyInListModal.style.display = "none"; }
if (el.alreadyInListNoBtn) el.alreadyInListNoBtn.addEventListener("click", closeAlreadyInListModal);
if (el.alreadyInListEditBtn) {
  el.alreadyInListEditBtn.addEventListener("click", () => {
    const line = state.order.find((l) => l.id === alreadyInListLineId); if (!line) { closeAlreadyInListModal(); return; }
    const item = state.stocks.find((s) => s.id === line.itemId); closeAlreadyInListModal(); openEditQtyModal(line, item);
  });
}
if (el.alreadyInListModal) el.alreadyInListModal.addEventListener("click", (event) => { if (event.target === el.alreadyInListModal) closeAlreadyInListModal(); });

let editingStockModalId = null;
function openEditStockModal(item) {
  editingStockModalId = item.id;
  if (el.editStockName) el.editStockName.value = item.name;
  if (el.editStockSupplierSearch) el.editStockSupplierSearch.value = supplierName(item.supplierId);
  if (el.editStockHiddenSupplierId) el.editStockHiddenSupplierId.value = item.supplierId;
  if (el.editStockUnit) el.editStockUnit.value = item.unit || "";
  if (el.editStockModal) el.editStockModal.style.display = "flex";
  setTimeout(() => { if (el.editStockName) { el.editStockName.focus(); } }, 50);
}

let _quickAddSupplierCallerSearchInput = null;
let _quickAddSupplierCallerHiddenInput = null;

function openQuickAddSupplierModal(searchInput, hiddenInput) {
  _quickAddSupplierCallerSearchInput = searchInput; _quickAddSupplierCallerHiddenInput = hiddenInput;
  if (el.supplierSuggestionsBox) el.supplierSuggestionsBox.style.display = "none";
  if (el.editStockSupplierSuggestionsBox) el.editStockSupplierSuggestionsBox.style.display = "none";
  if (el.stockSearchSuggestionsBox) el.stockSearchSuggestionsBox.style.display = "none";
  if (el.supplierSearchSuggestionsBox) el.supplierSearchSuggestionsBox.style.display = "none";
  if (el.supplierFilterSuggestionsBox) el.supplierFilterSuggestionsBox.style.display = "none";
  if (el.quickStockItemSupplierSuggestionsBox) el.quickStockItemSupplierSuggestionsBox.style.display = "none";
  if (el.searchSuggestionsBox) el.searchSuggestionsBox.style.display = "none";

  const prefill = searchInput?.value.trim() || "";
  if (el.quickSupplierName) el.quickSupplierName.value = prefill;
  if (el.quickSupplierEmail) el.quickSupplierEmail.value = "";
  if (el.quickSupplierPhone) el.quickSupplierPhone.value = "";
  if (el.quickAddSupplierModal) el.quickAddSupplierModal.style.display = "flex";
  setTimeout(() => { if (el.quickSupplierName) el.quickSupplierName.focus(); }, 50);
}

function closeQuickAddSupplierModal() {
  if (el.quickAddSupplierModal) el.quickAddSupplierModal.style.display = "none";
  _quickAddSupplierCallerSearchInput = null; _quickAddSupplierCallerHiddenInput = null;
}

function saveQuickAddSupplierModal() {
  const name = el.quickSupplierName?.value.trim();
  const email = el.quickSupplierEmail?.value.trim() || "";
  const phone = (el.quickSupplierPhone?.value.trim() || "").replace(/[^0-9+]/g, "");

  if (!name) { showConfirm("Missing Name", "Please enter a supplier name.", "OK", false); return; }
  const duplicate = state.suppliers.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) {
    if (_quickAddSupplierCallerSearchInput) _quickAddSupplierCallerSearchInput.value = duplicate.name;
    if (_quickAddSupplierCallerHiddenInput) _quickAddSupplierCallerHiddenInput.value = duplicate.id;
    closeQuickAddSupplierModal(); return;
  }

  const newSupplier = { id: generateUUID(), name, email, phone };
  state.suppliers.push(newSupplier); saveState();
  syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(newSupplier)] });
  renderSupplierOptions(); renderSupplierList();

  if (_quickAddSupplierCallerSearchInput) _quickAddSupplierCallerSearchInput.value = newSupplier.name;
  if (_quickAddSupplierCallerHiddenInput) _quickAddSupplierCallerHiddenInput.value = newSupplier.id;
  closeQuickAddSupplierModal();
}

if (el.quickAddSupplierSaveBtn) el.quickAddSupplierSaveBtn.addEventListener("click", saveQuickAddSupplierModal);
if (el.quickAddSupplierCancelBtn) el.quickAddSupplierCancelBtn.addEventListener("click", closeQuickAddSupplierModal);
if (el.quickAddSupplierModal) el.quickAddSupplierModal.addEventListener("click", (e) => { if (e.target === el.quickAddSupplierModal) closeQuickAddSupplierModal(); });
if (el.quickSupplierName) el.quickSupplierName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddSupplierModal(); } });
if (el.quickAddSupplierBtn) el.quickAddSupplierBtn.addEventListener("click", () => { if (el.supplierSuggestionsBox) el.supplierSuggestionsBox.style.display = "none"; openQuickAddSupplierModal(document.querySelector("#stockSupplierSearchInput"), document.querySelector("#hiddenStockSupplierId")); });
if (el.editStockQuickAddSupplierBtn) el.editStockQuickAddSupplierBtn.addEventListener("click", () => { if (el.editStockSupplierSuggestionsBox) el.editStockSupplierSuggestionsBox.style.display = "none"; openQuickAddSupplierModal(el.editStockSupplierSearch, el.editStockHiddenSupplierId); });

let _quickAddStockItemCallerSearchInput = null;
let _quickAddStockItemCallerHiddenInput = null;

function openQuickAddStockItemModal(searchInput, hiddenInput) {
  _quickAddStockItemCallerSearchInput = searchInput; _quickAddStockItemCallerHiddenInput = hiddenInput;
  if (el.searchSuggestionsBox) el.searchSuggestionsBox.style.display = "none";
  if (el.supplierSuggestionsBox) el.supplierSuggestionsBox.style.display = "none";
  if (el.editStockSupplierSuggestionsBox) el.editStockSupplierSuggestionsBox.style.display = "none";
  if (el.stockSearchSuggestionsBox) el.stockSearchSuggestionsBox.style.display = "none";
  if (el.supplierSearchSuggestionsBox) el.supplierSearchSuggestionsBox.style.display = "none";
  if (el.supplierFilterSuggestionsBox) el.supplierFilterSuggestionsBox.style.display = "none";

  const prefill = searchInput?.value.trim() || "";
  if (el.quickStockItemName) el.quickStockItemName.value = prefill;
  if (el.quickStockItemUnit) el.quickStockItemUnit.value = "";
  if (el.quickStockItemSupplierSearch) el.quickStockItemSupplierSearch.value = "";
  if (el.quickStockItemHiddenSupplierId) el.quickStockItemHiddenSupplierId.value = "";
  if (el.quickStockItemSupplierSuggestionsBox) el.quickStockItemSupplierSuggestionsBox.style.display = "none";
  closeInlineNewSupplierPanel();
  if (el.quickAddStockItemModal) el.quickAddStockItemModal.style.display = "flex";
  setTimeout(() => { if (el.quickStockItemName) el.quickStockItemName.focus(); }, 50);
}

function closeQuickAddStockItemModal() {
  if (el.quickAddStockItemModal) el.quickAddStockItemModal.style.display = "none";
  _quickAddStockItemCallerSearchInput = null; _quickAddStockItemCallerHiddenInput = null; closeInlineNewSupplierPanel();
}

function isInlineNewSupplierPanelOpen() { return !!(el.quickStockItemNewSupplierPanel && el.quickStockItemNewSupplierPanel.style.display !== "none"); }
function openInlineNewSupplierPanel() {
  if (el.quickStockItemSupplierSuggestionsBox) el.quickStockItemSupplierSuggestionsBox.style.display = "none";
  if (el.quickStockItemHiddenSupplierId) el.quickStockItemHiddenSupplierId.value = "";
  const prefill = el.quickStockItemSupplierSearch?.value.trim() || "";
  if (el.quickStockItemNewSupplierName) el.quickStockItemNewSupplierName.value = prefill;
  if (el.quickStockItemNewSupplierEmail) el.quickStockItemNewSupplierEmail.value = "";
  if (el.quickStockItemNewSupplierPhone) el.quickStockItemNewSupplierPhone.value = "";
  if (el.quickStockItemNewSupplierPanel) el.quickStockItemNewSupplierPanel.style.display = "block";
  setTimeout(() => { if (el.quickStockItemNewSupplierName) el.quickStockItemNewSupplierName.focus(); }, 50);
}
function closeInlineNewSupplierPanel() {
  if (el.quickStockItemNewSupplierPanel) el.quickStockItemNewSupplierPanel.style.display = "none";
  if (el.quickStockItemNewSupplierName) el.quickStockItemNewSupplierName.value = "";
  if (el.quickStockItemNewSupplierEmail) el.quickStockItemNewSupplierEmail.value = "";
  if (el.quickStockItemNewSupplierPhone) el.quickStockItemNewSupplierPhone.value = "";
}

if (el.quickStockItemQuickAddSupplierBtn) el.quickStockItemQuickAddSupplierBtn.addEventListener("click", () => { if (isInlineNewSupplierPanelOpen()) closeInlineNewSupplierPanel(); else openInlineNewSupplierPanel(); });

function saveQuickAddStockItemModal() {
  const name = el.quickStockItemName?.value.trim();
  const unit = formatUnit(el.quickStockItemUnit?.value || "");
  let supplierId = el.quickStockItemHiddenSupplierId?.value || "";

  if (!name) { showConfirm("Missing Name", "Please enter an item name.", "OK", false); return; }
  if (!unit) { showConfirm("Missing Unit", "Please enter a unit (pcs, packs, bags, kg, etc.).", "OK", false); return; }

  let newSupplierName = "", newSupplierEmail = "", newSupplierPhone = "";
  if (!supplierId && isInlineNewSupplierPanelOpen()) {
    newSupplierName = el.quickStockItemNewSupplierName?.value.trim() || "";
    newSupplierEmail = el.quickStockItemNewSupplierEmail?.value.trim() || "";
    newSupplierPhone = (el.quickStockItemNewSupplierPhone?.value.trim() || "").replace(/[^0-9+]/g, "");
  }

  if (!supplierId && !newSupplierName) { showConfirm("Missing Supplier", "Please select a supplier from the autocomplete suggestions list, or tap + and enter a new supplier name.", "OK", false); return; }

  const duplicate = state.stocks.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) {
    if (_quickAddStockItemCallerSearchInput) _quickAddStockItemCallerSearchInput.value = duplicate.name;
    if (_quickAddStockItemCallerHiddenInput) _quickAddStockItemCallerHiddenInput.value = duplicate.id;
    closeQuickAddStockItemModal(); return;
  }

  if (!supplierId && newSupplierName) {
    const existingSupplier = state.suppliers.find(s => s.name.trim().toLowerCase() === newSupplierName.toLowerCase());
    if (existingSupplier) { supplierId = existingSupplier.id; } 
    else {
      const newSupplier = { id: generateUUID(), name: newSupplierName, email: newSupplierEmail, phone: newSupplierPhone };
      state.suppliers.push(newSupplier); syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(newSupplier)] }); renderSupplierOptions(); renderSupplierList(); supplierId = newSupplier.id;
    }
  }

  const newStock = { id: generateUUID(), name, supplierId, unit };
  state.stocks.push(newStock); saveState(); syncToSupabase("stocks", "upsert", { rows: [stockToDb(newStock)] }); render();
  if (_quickAddStockItemCallerSearchInput) _quickAddStockItemCallerSearchInput.value = newStock.name;
  if (_quickAddStockItemCallerHiddenInput) _quickAddStockItemCallerHiddenInput.value = newStock.id;
  closeQuickAddStockItemModal();
}

if (el.quickAddStockItemSaveBtn) el.quickAddStockItemSaveBtn.addEventListener("click", saveQuickAddStockItemModal);
if (el.quickAddStockItemCancelBtn) el.quickAddStockItemCancelBtn.addEventListener("click", closeQuickAddStockItemModal);
if (el.quickAddStockItemModal) el.quickAddStockItemModal.addEventListener("click", (e) => { if (e.target === el.quickAddStockItemModal) closeQuickAddStockItemModal(); });
if (el.quickStockItemName) el.quickStockItemName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddStockItemModal(); } });
if (el.quickStockItemUnit) el.quickStockItemUnit.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddStockItemModal(); } });
if (el.quickStockItemNewSupplierName) el.quickStockItemNewSupplierName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddStockItemModal(); } });
if (el.quickStockItemNewSupplierEmail) el.quickStockItemNewSupplierEmail.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddStockItemModal(); } });
if (el.quickStockItemNewSupplierPhone) el.quickStockItemNewSupplierPhone.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveQuickAddStockItemModal(); } });

// Supplier autocomplete inside the quick add stock item modal
if (el.quickStockItemSupplierSearch) {
  const showQuickStockItemSuppliers = () => {
    const query = el.quickStockItemSupplierSearch.value.trim().toLowerCase();
    const matches = (query ? state.suppliers.filter(s => s.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));
    if (!state.suppliers.length) { el.quickStockItemSupplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers added yet. Use the + button to add one.</div>`; } 
    else if (!matches.length) { el.quickStockItemSupplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No matches. Use the + button to add "${escapeHtml(el.quickStockItemSupplierSearch.value.trim())}" as a new supplier.</div>`; } 
    else { el.quickStockItemSupplierSuggestionsBox.innerHTML = matches.map(s => `<div class="suggestion-item supplier-suggestion-item" data-id="${s.id}" data-name="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong></div>`).join(""); }
    el.quickStockItemSupplierSuggestionsBox.style.display = "block";
  };
  el.quickStockItemSupplierSearch.addEventListener("input", () => { closeInlineNewSupplierPanel(); if (el.quickStockItemHiddenSupplierId) el.quickStockItemHiddenSupplierId.value = ""; showQuickStockItemSuppliers(); });
  el.quickStockItemSupplierSearch.addEventListener("focus", showQuickStockItemSuppliers);
}

if (el.quickStockItemSupplierSuggestionsBox) {
  el.quickStockItemSupplierSuggestionsBox.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".supplier-suggestion-item"); if (!item) return; e.preventDefault();
    if (el.quickStockItemSupplierSearch) el.quickStockItemSupplierSearch.value = item.dataset.name;
    if (el.quickStockItemHiddenSupplierId) el.quickStockItemHiddenSupplierId.value = item.dataset.id;
    closeInlineNewSupplierPanel(); el.quickStockItemSupplierSuggestionsBox.style.display = "none";
  });
}

if (el.headerAddStockBtn) el.headerAddStockBtn.addEventListener("click", () => openQuickAddStockItemModal(null, null));
if (el.headerDataBtn) el.headerDataBtn.addEventListener("click", () => showPage(el.headerDataBtn.dataset.pageTarget));
if (el.stockPageAddItemBtn) el.stockPageAddItemBtn.addEventListener("click", () => openQuickAddStockItemModal(null, null));
if (el.quickAddStockItemBtn) el.quickAddStockItemBtn.addEventListener("click", () => openQuickAddStockItemModal(el.orderItemSearchInput, el.hiddenOrderItemId));

function closeEditStockModal() {
  editingStockModalId = null;
  if (el.editStockModal) el.editStockModal.style.display = "none";
  if (el.editStockSupplierSuggestionsBox) el.editStockSupplierSuggestionsBox.style.display = "none";
}

function saveEditStockModal() {
  const name = el.editStockName?.value.trim(); const supplierId = el.editStockHiddenSupplierId?.value; const unit = formatUnit(el.editStockUnit?.value);
  if (!name) { showConfirm("Missing Name", "Please enter an item name.", "OK", false); return; }
  if (!supplierId) { showConfirm("Missing Supplier", "Please select a supplier from the list.", "OK", false); return; }
  const duplicate = state.stocks.find(s => s.id !== editingStockModalId && s.name.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) { showConfirm("Name Already Exists", `"${name}" is already in your stock list.\n\nPlease use a different name for this item.`, "OK", false); return; }
  const item = state.stocks.find(s => s.id === editingStockModalId); if (!item) { closeEditStockModal(); return; }
  item.name = name; item.supplierId = supplierId; item.unit = unit; saveState(); syncToSupabase("stocks", "upsert", { rows: [stockToDb(item)] }); closeEditStockModal(); render();
}

if (el.editStockSaveBtn) el.editStockSaveBtn.addEventListener("click", saveEditStockModal);
if (el.editStockCancelBtn) el.editStockCancelBtn.addEventListener("click", closeEditStockModal);
if (el.editStockModal) el.editStockModal.addEventListener("click", (e) => { if (e.target === el.editStockModal) closeEditStockModal(); });

if (el.editStockSupplierSearch) {
  const showEditStockSuppliers = () => {
    const query = el.editStockSupplierSearch.value.trim().toLowerCase();
    const matches = (query ? state.suppliers.filter(s => s.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));
    if (!matches.length) { el.editStockSupplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No matches</div>`; } 
    else { el.editStockSupplierSuggestionsBox.innerHTML = matches.map(s => `<div class="suggestion-item supplier-suggestion-item" data-id="${s.id}" data-name="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong></div>`).join(""); }
    el.editStockSupplierSuggestionsBox.style.display = "block";
  };
  el.editStockSupplierSearch.addEventListener("input", showEditStockSuppliers);
  el.editStockSupplierSearch.addEventListener("focus", showEditStockSuppliers);
}

if (el.editStockSupplierSuggestionsBox) {
  el.editStockSupplierSuggestionsBox.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".supplier-suggestion-item"); if (!item) return; e.preventDefault();
    if (el.editStockSupplierSearch) el.editStockSupplierSearch.value = item.dataset.name;
    if (el.editStockHiddenSupplierId) el.editStockHiddenSupplierId.value = item.dataset.id;
    el.editStockSupplierSuggestionsBox.style.display = "none";
  });
}

function openEditSupplierModal(supplier) {
  editingSupplierModalId = supplier.id;
  if (el.editSupplierName) el.editSupplierName.value = supplier.name;
  if (el.editSupplierEmail) el.editSupplierEmail.value = supplier.email || "";
  if (el.editSupplierPhone) el.editSupplierPhone.value = supplier.phone || "";
  if (el.editSupplierModal) el.editSupplierModal.style.display = "flex";
  setTimeout(() => { if (el.editSupplierName) el.editSupplierName.focus(); }, 50);
}
function closeEditSupplierModal() { editingSupplierModalId = null; if (el.editSupplierModal) el.editSupplierModal.style.display = "none"; }
function saveEditSupplierModal() {
  const name = el.editSupplierName?.value.trim(); const email = el.editSupplierEmail?.value.trim(); const phone = (el.editSupplierPhone?.value.trim() || "").replace(/[^0-9+]/g, "");
  if (!name) { alert("Please enter a supplier name."); return; }
  const supplier = state.suppliers.find(s => s.id === editingSupplierModalId); if (!supplier) { closeEditSupplierModal(); return; }
  supplier.name = name; supplier.email = email; supplier.phone = phone; saveState(); syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(supplier)] }); closeEditSupplierModal(); render();
}
if (el.editSupplierSaveBtn) el.editSupplierSaveBtn.addEventListener("click", saveEditSupplierModal);
if (el.editSupplierCancelBtn) el.editSupplierCancelBtn.addEventListener("click", closeEditSupplierModal);
if (el.editSupplierModal) el.editSupplierModal.addEventListener("click", (e) => { if (e.target === el.editSupplierModal) closeEditSupplierModal(); });

function openEditQtyModal(line, item) {
  addingOrderItemId = null; editingQtyLineId = line.id;
  if (el.editQtyModalTitle) el.editQtyModalTitle.textContent = "Edit Quantity";
  if (el.editQtySaveBtn) el.editQtySaveBtn.textContent = "Save";
  if (el.editQtyItemName) el.editQtyItemName.textContent = `${item?.name || "Deleted item"} (${item?.unit || "pcs"})`;
  if (el.editQtyInput) el.editQtyInput.value = line.quantity;
  if (el.editQtyModal) el.editQtyModal.style.display = "flex";
  setTimeout(() => { if (el.editQtyInput) { el.editQtyInput.focus(); el.editQtyInput.select(); } }, 50);
}
function closeEditQtyModal() { editingQtyLineId = null; addingOrderItemId = null; if (el.editQtyModal) el.editQtyModal.style.display = "none"; }
function saveEditQtyModal() {
  const qty = Math.max(1, Number(el.editQtyInput?.value) || 0); if (!qty) { alert("Please enter a valid quantity."); return; }
  if (addingOrderItemId) {
    const item = state.stocks.find((s) => s.id === addingOrderItemId); if (!item) { closeEditQtyModal(); return; }
    addOrUpdateOrderLine(item, qty); saveState(); closeEditQtyModal(); return;
  }
  if (editingQtyLineId) {
    const line = state.order.find((l) => l.id === editingQtyLineId); if (!line) { closeEditQtyModal(); return; }
    line.quantity = qty; saveState(); syncToSupabase("orders", "upsert", { rows: [orderToDb(line)] }); closeEditQtyModal();
    if (focusedSupplierId && el.deepView && el.deepView.style.display !== "none") openSupplierDeepView(focusedSupplierId, focusedBatchId);
  }
}

if (el.editQtySaveBtn) el.editQtySaveBtn.addEventListener("click", saveEditQtyModal);
if (el.editQtyCancelBtn) el.editQtyCancelBtn.addEventListener("click", closeEditQtyModal);
if (el.editQtyInput) el.editQtyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveEditQtyModal(); } else if (event.key === "Escape") { closeEditQtyModal(); } });
if (el.editQtyModal) el.editQtyModal.addEventListener("click", (event) => { if (event.target === el.editQtyModal) closeEditQtyModal(); });

function updateMasterBulkDeleteToolbarState() {
  const count = masterSelectedKeys.size;
  if (count > 0) {
    const countText = `${count} order${count === 1 ? "" : "s"} selected`;
    el.masterBulkDeleteCountLabel.textContent = countText; el.masterBulkDeleteToolbar.style.display = "flex"; showHeaderSelection("master"); setHeaderSelectionCount(countText);
  } else {
    el.masterBulkDeleteToolbar.style.display = "none"; if (el.masterView) el.masterView.classList.remove("selection-active"); hideHeaderSelection();
  }
}

function openSupplierDeepView(supplierId, batchId) {
  focusedSupplierId = supplierId; focusedBatchId = currentStatusFilter === "completed" ? (batchId || "") : null;
  const supplier = state.suppliers.find(s => s.id === supplierId);
  const filteredLines = state.order.filter(line => {
    if (line.supplierId !== supplierId) return false;
    if ((line.status || "active") !== currentStatusFilter) return false;
    if (currentStatusFilter === "completed") return (line.batchId || "") === focusedBatchId;
    return true;
  });

  if (!filteredLines.length) {
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    renderBifurcatedOrders(); return;
  }

  // History API - Register the overlay in the back stack
  history.pushState({ isAppOpen: true, isDeepView: true }, "", location.hash + "-detail");

  if (el.deepViewVendorTitle) el.deepViewVendorTitle.textContent = supplier ? supplier.name : "Supplier";
  const dateStr = currentStatusFilter === "completed" ? formatDisplayDate(filteredLines[0].dateCompleted || filteredLines[0].dateCreated) : formatDisplayDate(filteredLines[0].dateCreated);
  if (el.deepViewDateLabel) el.deepViewDateLabel.textContent = `Date: ${dateStr}`;

  if (el.toggleStatusStateBtn) {
    if (currentStatusFilter === "completed") {
      if (el.deepViewActionsContainer) el.deepViewActionsContainer.style.display = "none";
      el.toggleStatusStateBtn.textContent = "Move to Active"; el.toggleStatusStateBtn.classList.add("revert-mode");
    } else {
      if (el.deepViewActionsContainer) el.deepViewActionsContainer.style.display = "flex";
      el.toggleStatusStateBtn.textContent = "Move to Completed"; el.toggleStatusStateBtn.classList.remove("revert-mode");
    }
  }

  resetDeepSelection(); hideHeaderSelection();

  if (el.deepViewLinesList) {
    el.deepViewLinesList.innerHTML = filteredLines.map((line) => {
      const item = state.stocks.find(s => s.id === line.itemId);
      return `<div class="order-card" data-line-id="${line.id}" style="background: #fff; border: 1px solid var(--line); padding: 10px; margin-bottom: 6px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; min-width: 0; gap: 10px;">
          <div style="min-width: 0; flex: 1 1 auto; margin-left: 2px; overflow: hidden;">
            <strong style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item?.name || "Deleted item")}</strong>
            <div class="order-meta" style="font-size: 0.85rem; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Qty: ${formatNumber(line.quantity)} ${escapeHtml(item?.unit || "pcs")}</div>
          </div>
          ${currentStatusFilter === 'active' ? `<button class="icon-btn" type="button" data-action="edit-deep-line" data-line-id="${line.id}" title="Edit quantity" style="min-width: 32px; min-height: 32px; height: 32px; width: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 6px; border: 1px solid var(--line); background:#fff; font-size: 15px;">✏️</button>` : ''}
        </div>`;
    }).join("");
    setupDeepViewLongPressTriggers(); 
  }

  if (el.masterView) el.masterView.style.display = "none";
  if (el.deepView) el.deepView.style.display = "block";
}

function updateBulkDeleteToolbarState() {
  const count = deepSelectedIds.size;
  if (count > 0 && currentStatusFilter === "active") {
    const countText = `${count} item${count === 1 ? "" : "s"} selected`; el.bulkDeleteCountLabel.textContent = countText; el.bulkDeleteToolbar.style.display = "flex"; showHeaderSelection("deep"); setHeaderSelectionCount(countText);
  } else {
    el.bulkDeleteToolbar.style.display = "none"; if (el.deepView) el.deepView.classList.remove("selection-active"); hideHeaderSelection();
  }
}

document.addEventListener("click", async (event) => {
  if (isLongPressTriggered) { isLongPressTriggered = false; return; }
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const id = button.dataset.id; const action = button.dataset.action;
  if (action === "remove-line") {
    if (await showConfirm("Remove Item", "Are you sure you want to permanently delete this order item?")) {
      state.order = state.order.filter((line) => line.id !== id); saveState(); syncToSupabase("orders", "delete", { ids: [id] }); render();
    }
  }
  if (action === "edit-deep-line") {
    const lineId = button.dataset.lineId; const line = state.order.find((l) => l.id === lineId); if (!line) return;
    const item = state.stocks.find((s) => s.id === line.itemId); openEditQtyModal(line, item);
  }
});

// Intercepts the back button so it handles native back gesture safely
if (el.backToMasterBtn) {
  el.backToMasterBtn.addEventListener("click", () => history.back());
}

if (el.toggleStatusStateBtn) {
  el.toggleStatusStateBtn.addEventListener("click", async () => {
    if (!focusedSupplierId) return;
    if (currentStatusFilter === "active") {
      if (await showConfirm("Send Order", "Move this entire purchase list to completed orders?", "Move to Completed", false)) toggleActiveCompletedState(focusedSupplierId, "completed");
    } else {
      if (await showConfirm("Revert Order", "Move this entire purchase list back to active order lists?", "Move to Active", false)) toggleActiveCompletedState(focusedSupplierId, "active", focusedBatchId);
    }
  });
}

if (el.bulkDeleteExecuteBtn) {
  el.bulkDeleteExecuteBtn.addEventListener("click", async () => {
    const count = deepSelectedIds.size; if (!count) return;
    if (await showConfirm("Delete Items", `Remove these ${count} selected item${count === 1 ? "" : "s"} from your active order?`)) {
      const idsToDelete = Array.from(deepSelectedIds); state.order = state.order.filter(line => !idsToDelete.includes(line.id)); saveState(); syncToSupabase("orders", "delete", { ids: idsToDelete }); openSupplierDeepView(focusedSupplierId, focusedBatchId);
    }
  });
}

if (el.bulkDeleteCancelBtn) el.bulkDeleteCancelBtn.addEventListener("click", () => resetDeepSelection());

if (el.masterBulkDeleteExecuteBtn) {
  el.masterBulkDeleteExecuteBtn.addEventListener("click", async () => {
    const count = masterSelectedKeys.size; if (!count) return;
    const statusLabel = currentStatusFilter === "completed" ? "completed" : "active";
    if (await showConfirm(currentStatusFilter === "completed" ? "Delete Completed Orders" : "Delete Active Orders", `Permanently delete ${count} selected ${statusLabel} order${count === 1 ? "" : "s"}? This cannot be undone.`)) {
      const pairsToDelete = new Set(masterSelectedKeys);
      const idsToDelete = state.order.filter(line => (line.status || "active") === currentStatusFilter && pairsToDelete.has(`${line.supplierId}::${line.batchId || ""}`)).map(line => line.id);
      state.order = state.order.filter(line => !idsToDelete.includes(line.id)); saveState(); syncToSupabase("orders", "delete", { ids: idsToDelete }); resetMasterSelection(); renderBifurcatedOrders();
    }
  });
}

if (el.masterBulkDeleteCancelBtn) el.masterBulkDeleteCancelBtn.addEventListener("click", () => { resetMasterSelection(); if (el.masterBulkDeleteCountLabel) el.masterBulkDeleteCountLabel.textContent = "0 orders selected"; });

if (el.searchSuggestionsBox) {
  el.searchSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item"); if (!suggestionItem || !suggestionItem.dataset.id) return; event.preventDefault();
    const selectedItem = state.stocks.find(s => s.id === suggestionItem.dataset.id);
    const existingLine = selectedItem ? state.order.find(l => l.itemId === selectedItem.id && (l.status || "active") === "active") : null;
    if (existingLine && selectedItem) {
      el.searchSuggestionsBox.style.display = "none"; alreadyInListLineId = existingLine.id;
      if (el.alreadyInListTitle) el.alreadyInListTitle.textContent = "Already in Order";
      if (el.alreadyInListBody) {
        el.alreadyInListBody.innerHTML = `<strong>${escapeHtml(selectedItem.name)}</strong> is already in your active order list.<br><br>Current quantity: <strong>${existingLine.quantity} ${escapeHtml(selectedItem.unit || "pcs")}</strong><br><br>Would you like to edit the quantity?`;
      }
      if (el.alreadyInListModal) el.alreadyInListModal.style.display = "flex"; return;
    }
    if (el.orderItemSearchInput) el.orderItemSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = suggestionItem.dataset.id;
    if (selectedItem && el.orderQtyInlineUnit) el.orderQtyInlineUnit.textContent = selectedItem.unit || "pcs";
    el.searchSuggestionsBox.style.display = "none";
    if (el.orderQty) { el.orderQty.focus(); el.orderQty.select(); }
  });
}

if (el.supplierSuggestionsBox) {
  el.supplierSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".supplier-suggestion-item"); if (!suggestionItem || !suggestionItem.dataset.id) return; event.preventDefault();
    if (el.stockSupplierSearchInput) el.stockSupplierSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenStockSupplierId) el.hiddenStockSupplierId.value = suggestionItem.dataset.id;
    el.supplierSuggestionsBox.style.display = "none";
  });
}

document.addEventListener("click", (event) => {
  if (el.searchSuggestionsBox && !event.target.closest(".search-suggest-container")) el.searchSuggestionsBox.style.display = "none";
  if (el.supplierSuggestionsBox && !event.target.closest(".search-suggest-container")) el.supplierSuggestionsBox.style.display = "none";
  if (el.stockSearchSuggestionsBox && !event.target.closest(".search-suggest-container")) el.stockSearchSuggestionsBox.style.display = "none";
  if (el.supplierSearchSuggestionsBox && !event.target.closest(".search-suggest-container")) el.supplierSearchSuggestionsBox.style.display = "none";
  if (el.supplierFilterSuggestionsBox && !event.target.closest(".search-suggest-container")) el.supplierFilterSuggestionsBox.style.display = "none";
  if (el.quickStockItemSupplierSuggestionsBox && !event.target.closest(".search-suggest-container")) el.quickStockItemSupplierSuggestionsBox.style.display = "none";
});

if (el.orderItemSearchInput) { el.orderItemSearchInput.addEventListener("input", handleSearchInput); el.orderItemSearchInput.addEventListener("focus", handleSearchInput); }
if (el.stockSupplierSearchInput) { el.stockSupplierSearchInput.addEventListener("input", handleStockSupplierSearch); el.stockSupplierSearchInput.addEventListener("focus", handleStockSupplierSearch); }

if (el.stockForm) {
  el.stockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#itemName").value.trim(); const supplierId = el.hiddenStockSupplierId.value; const unit = formatUnit(document.querySelector("#itemUnit").value);
    if (!supplierId || el.stockSupplierSearchInput.value.trim() === "") { alert("Please select a valid supplier party from the autocomplete search suggestions menu list popup first."); return; }
    const duplicate = state.stocks.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) { showConfirm("Item Already Exists", `"${name}" is already in your stock list.\n\nIf you want to update its details, use the ✏️ edit button on that item instead.`, "OK", false); return; }
    const newStock = { id: generateUUID(), name, supplierId, unit };
    state.stocks.push(newStock); syncToSupabase("stocks", "upsert", { rows: [stockToDb(newStock)] }); saveState();
    el.stockForm.reset(); if (el.hiddenStockSupplierId) el.hiddenStockSupplierId.value = ""; document.querySelector("#itemUnit").value = ""; render();
  });
}

if (el.supplierForm) {
  el.supplierForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#supplierName").value.trim(); const email = document.querySelector("#supplierEmail").value.trim(); const phone = document.querySelector("#supplierPhone").value.trim().replace(/[^0-9+]/g, "");
    const duplicate = state.suppliers.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) { alert(`"${name}" already exists in your supplier list. If you want to update their details, use the ✏️ edit button on that supplier instead.`); return; }
    const newSupplier = { id: generateUUID(), name, email, phone };
    state.suppliers.push(newSupplier); syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(newSupplier)] }); saveState(); el.supplierForm.reset(); render();
  });
}

if (el.orderForm) {
  el.orderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selectedItemId = el.hiddenOrderItemId.value; const item = state.stocks.find((stock) => stock.id === selectedItemId);
    if (!item || el.orderItemSearchInput.value !== item.name) { alert("Please select a valid item from the search suggestion menu popup."); return; }
    const qty = el.orderQty.value; addOrUpdateOrderLine(item, qty); saveState(); el.orderForm.reset(); clearInlineUnitLabel(); 
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = ""; if (el.orderQty) el.orderQty.value = 1;
    if (el.recentOrderAlert) {
      el.recentOrderAlert.innerHTML = `<div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">✔ Added: ${escapeHtml(item.name)} (Qty: ${qty})</div>`;
      el.recentOrderAlert.style.display = "block";
    }
    render();
  });
}

if (el.stockTable) {
  el.stockTable.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]"); if (!button) return;
    if (button.dataset.action === "edit-stock") { const item = state.stocks.find((stock) => stock.id === button.dataset.id); if (item) openEditStockModal(item); return; }
  });
}

if (el.stockBulkDeleteCancelBtn) el.stockBulkDeleteCancelBtn.addEventListener("click", hideStockBulkDeleteBar);
if (el.stockBulkDeleteExecuteBtn) {
  el.stockBulkDeleteExecuteBtn.addEventListener("click", async () => {
    const ids = Array.from(stockSelectedIds); if (!ids.length) return;
    const blockedItems = ids.filter(id => state.order.some(line => line.itemId === id));
    if (blockedItems.length) { await showConfirm("Cannot Delete", `${blockedItems.length} selected item${blockedItems.length === 1 ? "" : "s"} ${blockedItems.length === 1 ? "is" : "are"} present in your Active or Completed orders.\n\nRemove ${blockedItems.length === 1 ? "it" : "them"} from your orders first, then try deleting again.`, "OK", false); return; }
    if (!await showConfirm("Delete Stock Items", `Permanently delete ${ids.length} selected stock item${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    state.stocks = state.stocks.filter(s => !ids.includes(s.id)); saveState(); ids.forEach(id => syncToSupabase("stocks", "delete", { ids: [id] }));
    hideStockBulkDeleteBar(); render();
  });
}

if (el.deepWhatsAppBtn) {
  el.deepWhatsAppBtn.addEventListener("click", () => {
    if (!focusedSupplierId) return; const supplier = state.suppliers.find(s => s.id === focusedSupplierId); if (!supplier) return;
    const itemsText = buildCleanTextPayload(focusedSupplierId); const textMessage = `Hello ${supplier.name},\n\nPlease arrange delivery for the following purchase items:\n\n${itemsText}\n\nThank you.`; const cleanPhone = (supplier.phone || "").replace(/[^0-9]/g, "");
    window.open(`https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(textMessage)}`, "_blank"); toggleActiveCompletedState(focusedSupplierId, "completed");
  });
}

if (el.deepEmailBtn) {
  el.deepEmailBtn.addEventListener("click", () => {
    if (!focusedSupplierId) return; const supplier = state.suppliers.find(s => s.id === focusedSupplierId); if (!supplier) return;
    const itemsText = buildCleanTextPayload(focusedSupplierId); const emailBody = `Hello ${supplier.name},\n\nPlease process the following order for our shop:\n\n${itemsText}\n\nThank you.`;
    window.location.href = `mailto:${encodeURIComponent(supplier.email || "")}?subject=${encodeURIComponent("Shop Purchase Order Request")}&body=${encodeURIComponent(emailBody)}`; toggleActiveCompletedState(focusedSupplierId, "completed");
  });
}

if (el.stockSearch) {
  el.stockSearch.addEventListener("input", () => { renderStockTable(); handleStockSearchInput(); if (!el.stockSearch.value.trim()) clearQuickOrderBar(); });
  el.stockSearch.addEventListener("focus", handleStockSearchInput);
}
if (el.supplierFilter) {
  const showSupplierFilterSuggestions = () => {
    if (!el.supplierFilterSuggestionsBox) return;
    const query = el.supplierFilter.value.trim().toLowerCase();
    const matches = (query ? state.suppliers.filter(s => s.name.toLowerCase().includes(query)) : [...state.suppliers]).sort((a, b) => a.name.localeCompare(b.name));
    if (!matches.length) { el.supplierFilterSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers match</div>`; } 
    else {
      const allOption = `<div class="suggestion-item" data-name="" style="color:var(--muted);">Show all suppliers</div>`;
      el.supplierFilterSuggestionsBox.innerHTML = allOption + matches.map(s => `<div class="suggestion-item" data-name="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong></div>`).join("");
    }
    el.supplierFilterSuggestionsBox.style.display = "block";
  };
  el.supplierFilter.addEventListener("input", () => { showSupplierFilterSuggestions(); renderStockTable(); });
  el.supplierFilter.addEventListener("focus", showSupplierFilterSuggestions);
}

if (el.supplierFilterSuggestionsBox) el.supplierFilterSuggestionsBox.addEventListener("mousedown", (event) => { const item = event.target.closest(".suggestion-item"); if (!item) return; event.preventDefault(); el.supplierFilter.value = item.dataset.name || ""; el.supplierFilterSuggestionsBox.style.display = "none"; renderStockTable(); });
if (el.stockSearchSuggestionsBox) el.stockSearchSuggestionsBox.addEventListener("mousedown", (event) => { const suggestionItem = event.target.closest(".suggestion-item"); if (!suggestionItem || !suggestionItem.dataset.id) return; event.preventDefault(); if (el.stockSearch) el.stockSearch.value = suggestionItem.dataset.name || ""; el.stockSearchSuggestionsBox.style.display = "none"; renderStockTable(); });

if (el.stockQuickOrderAddBtn) {
  el.stockQuickOrderAddBtn.addEventListener("click", () => {
    if (!selectedQuickOrderItem) return;
    const qty = Math.max(1, Number(el.stockQuickOrderQty?.value) || 1); const addedItem = selectedQuickOrderItem;
    addOrUpdateOrderLine(addedItem, qty); saveState();
    if (el.stockQuickOrderAlert) {
      el.stockQuickOrderAlert.innerHTML = `<div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">✔ Added: ${escapeHtml(addedItem.name)} (Qty: ${qty})</div>`;
      el.stockQuickOrderAlert.style.display = "block"; setTimeout(() => { if (el.stockQuickOrderAlert) el.stockQuickOrderAlert.style.display = "none"; }, 3000);
    }
    clearQuickOrderBar(); if (el.stockSearch) el.stockSearch.value = ""; renderStockTable();
  });
}

if (el.stockQuickOrderCancelBtn) el.stockQuickOrderCancelBtn.addEventListener("click", () => { clearQuickOrderBar(); if (el.stockSearch) el.stockSearch.value = ""; renderStockTable(); });
if (el.stockQuickOrderQty) el.stockQuickOrderQty.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); if (el.stockQuickOrderAddBtn) el.stockQuickOrderAddBtn.click(); } });
if (el.supplierSearchInput) { el.supplierSearchInput.addEventListener("input", () => { renderSupplierList(); handleSupplierListSearch(); }); el.supplierSearchInput.addEventListener("focus", handleSupplierListSearch); }
if (el.supplierSearchSuggestionsBox) el.supplierSearchSuggestionsBox.addEventListener("mousedown", (event) => { const suggestionItem = event.target.closest(".suggestion-item"); if (!suggestionItem || !suggestionItem.dataset.id) return; event.preventDefault(); if (el.supplierSearchInput) el.supplierSearchInput.value = suggestionItem.dataset.name; el.supplierSearchSuggestionsBox.style.display = "none"; renderSupplierList(); });

el.tabButtons.forEach((button) => { button.addEventListener("click", () => showPage(button.dataset.pageTarget)); });

const CSV_HEADERS = ["Item Name", "Supplier", "Unit", "Supplier Email", "Supplier Phone"];
function downloadBlob(content, filename, mimeType) { const blob = new Blob([content], { type: mimeType }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
function buildStockExportRows() { return state.stocks.map((item) => { const supplier = state.suppliers.find((s) => s.id === item.supplierId); return { name: item.name, supplier: supplier?.name || "", unit: item.unit || "", email: supplier?.email || "", phone: supplier?.phone || "" }; }); }
function toCsvValue(value) { const str = String(value ?? ""); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; }
function buildCsvText() { const rows = buildStockExportRows(); const lines = [CSV_HEADERS.map(toCsvValue).join(",")]; rows.forEach((row) => { lines.push([row.name, row.supplier, row.unit, row.email, row.phone].map(toCsvValue).join(",")); }); return lines.join("\r\n"); }
function buildExcelHtml() {
  const rows = buildStockExportRows(); const headerCells = CSV_HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.supplier)}</td><td>${escapeHtml(row.unit)}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.phone)}</td></tr>`).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></body></html>`;
}
if (el.exportCsvBtn) el.exportCsvBtn.addEventListener("click", () => { if (!state.stocks.length) { alert("There are no stock items to export yet."); return; } downloadBlob(buildCsvText(), "shop-stock-list.csv", "text/csv;charset=utf-8;"); });
if (el.exportExcelBtn) el.exportExcelBtn.addEventListener("click", () => { if (!state.stocks.length) { alert("There are no stock items to export yet."); return; } downloadBlob(buildExcelHtml(), "shop-stock-list.xls", "application/vnd.ms-excel"); });
if (el.exportDataBtn) el.exportDataBtn.addEventListener("click", () => { downloadBlob(JSON.stringify(state, null, 2), "shop-stock-data.json", "application/json"); });

function findOrCreateSupplierByName(name, email, phone, newlyCreated) {
  const trimmedName = String(name || "").trim(); if (!trimmedName) return "";
  let supplier = state.suppliers.find((s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase());
  if (!supplier) { supplier = { id: generateUUID(), name: trimmedName, email: email || "", phone: phone || "" }; state.suppliers.push(supplier); if (newlyCreated) newlyCreated.push(supplier); }
  return supplier.id;
}

async function applyImportedStockRows(rows) {
  const newlyCreatedSuppliers = []; const affectedStocks = [];
  rows.filter((row) => row.name && row.name.trim()).forEach((row) => {
    const trimmedName = row.name.trim(); const supplierId = findOrCreateSupplierByName(row.supplier, row.email, row.phone, newlyCreatedSuppliers); const unit = formatUnit(row.unit);
    const existing = state.stocks.find((item) => item.name.trim().toLowerCase() === trimmedName.toLowerCase());
    if (existing) { if (supplierId) existing.supplierId = supplierId; if (unit) existing.unit = unit; affectedStocks.push(existing); } 
    else { const newItem = { id: generateUUID(), name: trimmedName, supplierId, unit }; state.stocks.push(newItem); affectedStocks.push(newItem); }
  });
  saveState();
  if (newlyCreatedSuppliers.length) await syncToSupabase("suppliers", "upsert", { rows: newlyCreatedSuppliers.map(supplierToDb) });
  if (affectedStocks.length) await syncToSupabase("stocks", "upsert", { rows: affectedStocks.map(stockToDb) });
  render();
}

function parseCsvText(text) {
  const rows = []; let row = []; let field = ""; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) { if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } } else { field += char; } } 
    else if (char === '"') { inQuotes = true; } else if (char === ",") { row.push(field); field = ""; } 
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; } 
    else { field += char; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function mapHeaderIndexes(headerRow) {
  const indexes = {};
  headerRow.forEach((header, idx) => {
    const key = String(header).trim().toLowerCase();
    if (key === "item name") indexes.name = idx; else if (key === "supplier") indexes.supplier = idx; else if (key === "unit") indexes.unit = idx; else if (key === "supplier email") indexes.email = idx; else if (key === "supplier phone") indexes.phone = idx;
  });
  return indexes;
}
function rowsFromTable(tableRows, headerIndexes) { return tableRows.map((cells) => ({ name: cells[headerIndexes.name] ?? "", supplier: headerIndexes.supplier !== undefined ? cells[headerIndexes.supplier] ?? "" : "", unit: headerIndexes.unit !== undefined ? cells[headerIndexes.unit] ?? "" : "", email: headerIndexes.email !== undefined ? cells[headerIndexes.email] ?? "" : "", phone: headerIndexes.phone !== undefined ? cells[headerIndexes.phone] ?? "" : "" })); }

function importFromCsvText(text) {
  const allRows = parseCsvText(text); if (!allRows.length) { alert("That CSV file appears to be empty."); return false; }
  const headerIndexes = mapHeaderIndexes(allRows[0]); if (headerIndexes.name === undefined) { alert("Could not find an 'Item Name' column in this CSV file."); return false; }
  const rows = rowsFromTable(allRows.slice(1), headerIndexes); applyImportedStockRows(rows); return true;
}

function importFromExcelHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html"); const table = doc.querySelector("table");
  if (!table) { alert("Could not read a stock table from this file. Only .xls files exported from this app are supported for import."); return false; }
  const tableRows = [...table.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th,td")].map((cell) => cell.textContent.trim()));
  if (!tableRows.length) { alert("That Excel file appears to be empty."); return false; }
  const headerIndexes = mapHeaderIndexes(tableRows[0]); if (headerIndexes.name === undefined) { alert("Could not find an 'Item Name' column in this Excel file."); return false; }
  const rows = rowsFromTable(tableRows.slice(1), headerIndexes); applyImportedStockRows(rows); return true;
}

async function fullRestoreToSupabase(suppliers, stocks, orders) {
  if (!sb) return;
  await syncToSupabase("orders", "replaceAll", { rows: [] }); await syncToSupabase("stocks", "replaceAll", { rows: [] }); await syncToSupabase("suppliers", "replaceAll", { rows: suppliers.map(supplierToDb) });
  if (stocks.length) await syncToSupabase("stocks", "upsert", { rows: stocks.map(stockToDb) });
  if (orders.length) await syncToSupabase("orders", "upsert", { rows: orders.map(orderToDb) });
}

async function importFromJsonText(text) {
  let parsed; try { parsed = JSON.parse(text); } catch { alert("That file is not valid JSON."); return false; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.suppliers) && !Array.isArray(parsed.stocks)) { alert("That JSON file doesn't look like a shop data backup."); return false; }
  state = { suppliers: Array.isArray(parsed.suppliers) ? parsed.suppliers : [], stocks: (Array.isArray(parsed.stocks) ? parsed.stocks : []).map(normalizeStockItem), order: Array.isArray(parsed.order) ? parsed.order : [] };
  saveState(); await fullRestoreToSupabase(state.suppliers, state.stocks, state.order); render(); return true;
}

if (el.importDataInput) {
  el.importDataInput.addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    const fileName = file.name.toLowerCase(); const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result; let success = false;
      if (fileName.endsWith(".json")) { if (await showConfirm("Import Backup", "This will replace ALL current data — suppliers, stock items, and orders. This cannot be undone.", "Import", true)) success = await importFromJsonText(text); } 
      else if (fileName.endsWith(".xls")) { if (await showConfirm("Import Excel", "This will add new stock items and update existing ones that match by name. Your current orders will not be affected.", "Import", false)) success = importFromExcelHtml(text); } 
      else { if (await showConfirm("Import CSV", "This will add new stock items and update existing ones that match by name. Your current orders will not be affected.", "Import", false)) success = importFromCsvText(text); }
      if (success) alert("Import complete."); el.importDataInput.value = "";
    };
    reader.onerror = () => { alert("Could not read that file. Please try again."); el.importDataInput.value = ""; }; reader.readAsText(file);
  });
}

function initializeApp() {
  renderSupplierOptions(); renderStockTable(); renderSupplierList(); renderBifurcatedOrders();
}

initializeApp();


// --- App Startup & History Trap Initialization ---
function initHistoryTrap() {
  if (!history.state || !history.state.isAppOpen) {
    history.replaceState({ base: true }, ""); 
    history.pushState({ isAppOpen: true }, "", location.hash || "#listPage");
  }
}

initHistoryTrap();
// Browsers ignore history manipulation until the user interacts with the page.
// This ensures the back-trap is solidly registered on their first screen tap.
document.body.addEventListener("touchstart", initHistoryTrap, { once: true, passive: true });
document.body.addEventListener("click", initHistoryTrap, { once: true, passive: true });

const pageId = (location.hash || "#listPage").slice(1).replace("-detail", "");
if (document.getElementById(pageId)) showPage(pageId, true);

syncOnStartup();


// --- Improved Mobile Keyboard Fix ---
let maxViewportHeight = window.innerHeight;
window.addEventListener("resize", () => {
  if (window.innerHeight > maxViewportHeight) maxViewportHeight = window.innerHeight;
  if (window.innerHeight < maxViewportHeight - 150) document.body.classList.add("keyboard-open"); 
  else document.body.classList.remove("keyboard-open");
});
document.addEventListener("focusout", () => {
  setTimeout(() => { if (!document.activeElement || !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) document.body.classList.remove("keyboard-open"); }, 50);
});


// --- Browser History / Android Native Back Swipe Handling ---
let isExiting = false;

window.addEventListener("popstate", async (e) => {
  if (isExiting) return;

  // 1. If confirm modal is open, user swiping/pressing back should simply close the modal,
  //    not be treated as a second attempt to exit. This re-arms the trap so a rapid second
  //    swipe while the "Quit App" dialog is up never falls through to a real exit.
  if (el.confirmModal && el.confirmModal.style.display === "flex") {
    if (el.confirmModalCancelBtn) el.confirmModalCancelBtn.click();
    history.pushState({ isAppOpen: true }, "", location.hash || "#listPage");
    return;
  }

  // 2. Main App Exit Trap
  if (!e.state || !e.state.isAppOpen) {
    // Immediate re-trap: pushes the safe state back instantly so a second swipe doesn't kill the app
    history.pushState({ isAppOpen: true }, "", location.hash || "#listPage");

    const confirmExit = await showConfirm("Quit App", "Are you sure you want to quit the app?", "Quit", true);
    if (confirmExit) {
      isExiting = true;
      history.go(-2); // Unwind past the base entry to trigger a real exit
      // Fallback for hosts that allow a script to close the last remaining tab/window.
      setTimeout(() => { try { window.close(); } catch (err) {} }, 50);
      // Safety net: if we're still here after a beat, the navigation/close silently failed
      // (an out-of-range history.go is a no-op per spec). Un-stick the trap so back handling
      // keeps working instead of leaving isExiting permanently true, which would otherwise
      // let every future back-swipe fall through uncontrolled.
      setTimeout(() => {
        if (document.visibilityState !== "hidden") {
          isExiting = false;
          history.replaceState({ isAppOpen: true }, "", location.hash || "#listPage");
        }
      }, 500);
    }
    return;
  }

  const currentHash = location.hash;
  
  // 3. Close deep views via the back gesture
  if (!currentHash.endsWith("-detail")) {
    let closedDeepView = false;
    if (el.deepView && el.deepView.style.display === "block") {
      resetDeepSelection();
      el.deepView.style.display = "none";
      if (el.masterView) el.masterView.style.display = "block";
      renderBifurcatedOrders();
      closedDeepView = true;
    }
    if (el.supplierStockDetailView && el.supplierStockDetailView.style.display === "block") {
      focusedSupplierDetailId = null;
      el.supplierStockDetailView.style.display = "none";
      if (el.supplierMasterView) el.supplierMasterView.style.display = "block";
      closedDeepView = true;
    }
    
    // Stop here if we closed a deep overlay, avoiding app exit
    if (closedDeepView) return;
  }

  // 4. Handle normal tab switching from browser history
  const historyPageId = currentHash.replace("#", "").replace("-detail", "");
  if (document.getElementById(historyPageId)) {
    showPage(historyPageId, true);
  }
});


// --- High-Performance WhatsApp-style Swipe Between Tabs ---
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartTime = 0;

if (el.appShell) {
  el.appShell.addEventListener("touchstart", (e) => {
    swipeStartX = e.changedTouches[0].screenX;
    swipeStartY = e.changedTouches[0].screenY;
    swipeStartTime = Date.now();
  }, { passive: true });

  el.appShell.addEventListener("touchend", (e) => {
    // Keyboard open: skip all swipe handling
    if (document.body.classList.contains("keyboard-open")) return;

    const modals = [el.confirmModal, el.alreadyInListModal, el.editStockModal, el.editSupplierModal, el.quickAddSupplierModal, el.quickAddStockItemModal, el.editQtyModal];
    if (modals.some(m => m && m.style.display === "flex")) return;

    // Smart Isolation: Skip page swipe if user is dragging an active horizontally scrollable container (like data tables)
    let targetNode = e.target;
    while (targetNode && targetNode !== el.appShell) {
      if (targetNode.scrollWidth > targetNode.clientWidth) {
        const overflowX = window.getComputedStyle(targetNode).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || targetNode.classList.contains("table-wrap")) {
          return; 
        }
      }
      targetNode = targetNode.parentNode;
    }

    const swipeEndX = e.changedTouches[0].screenX;
    const swipeEndY = e.changedTouches[0].screenY;
    
    const diffX = swipeStartX - swipeEndX; 
    const diffY = swipeStartY - swipeEndY;
    const elapsedTime = Date.now() - swipeStartTime;

    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);

    // 1. Vector Ratio Check: Must be a distinct horizontal gesture (horizontal travel must be double the vertical noise)
    // 2. Momentum Trigger: True if swipe clears 60px distance OR is a swift flick (>30px under 250ms)
    if (absX > absY * 2) {
      if (absX > 60 || (absX > 30 && elapsedTime < 250)) {

        // Inside a deep/detail view: any horizontal swipe goes back to the list, using the same button the "Back" buttons use
        const isOrderDeepViewOpen = el.deepView && el.deepView.style.display === "block";
        const isSupplierDetailViewOpen = el.supplierStockDetailView && el.supplierStockDetailView.style.display === "block";
        if (isOrderDeepViewOpen) { if (el.backToMasterBtn) el.backToMasterBtn.click(); return; }
        if (isSupplierDetailViewOpen) { if (el.supplierStockBackBtn) el.supplierStockBackBtn.click(); return; }

        const tabs = Array.from(el.tabButtons);
        const currentIndex = tabs.findIndex(btn => btn.classList.contains("active"));
        if (currentIndex === -1) return;

        if (diffX > 0 && currentIndex < tabs.length - 1) {
          tabs[currentIndex + 1].click(); // Swipe Left -> Next Tab Layer
        } else if (diffX < 0 && currentIndex > 0) {
          tabs[currentIndex - 1].click(); // Swipe Right -> Previous Tab Layer
        }
      }
    }
  }, { passive: true });
}
