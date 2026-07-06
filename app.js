const STORAGE_KEY = "shop-stock-order-app-v15";

function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback that still produces a valid UUID v4 string (Supabase's "id" columns are type uuid)
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
// Local storage stays the instant, offline-first source of truth. Every change
// is also pushed to Supabase in the background; if that fails (offline, etc.)
// it's queued in SYNC_QUEUE_KEY and retried automatically once back online.

const SUPABASE_URL = "https://jtaljezaydoauwcdkogo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0YWxqZXpheWRvYXV3Y2Rrb2dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MDAxNTUsImV4cCI6MjA5NzQ3NjE1NX0.0SxH9mMtJ1ze4D_ZPJUCb2PH-uVH6pui8OsX0bKOaCw";
const SYNC_QUEUE_KEY = "shop-stock-order-app-sync-queue-v1";

const sb =
  typeof window !== "undefined" && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// --- App-shape <-> DB-column mapping ---
function supplierToDb(s) {
  return {
    id: s.id,
    supplier_name: s.name || "",
    email: s.email || null,
    phone: s.phone || null
  };
}
function supplierFromDb(row) {
  return { id: row.id, name: row.supplier_name || "", email: row.email || "", phone: row.phone || "" };
}
function stockToDb(item) {
  return {
    id: item.id,
    item_name: item.name || "",
    supplier_id: item.supplierId || null,
    unit: item.unit || null
  };
}
function stockFromDb(row) {
  return { id: row.id, name: row.item_name || "", supplierId: row.supplier_id || "", unit: row.unit || "" };
}
function orderToDb(line) {
  return {
    id: line.id,
    item_id: line.itemId || null,
    supplier_id: line.supplierId || null,
    quantity: Number(line.quantity) || 1,
    status: line.status || "active",
    batch_id: line.batchId || null
  };
}
function orderFromDb(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    supplierId: row.supplier_id,
    quantity: Number(row.quantity) || 1,
    status: row.status || "active",
    dateCreated: row.created_at || getFormattedDate(),
    batchId: row.batch_id || null
  };
}

// --- Offline queue persistence ---
function loadSyncQueue() {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveSyncQueue(queue) {
  try {
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.warn("Could not persist sync queue:", err);
  }
}
function enqueueSync(table, op, payload) {
  const queue = loadSyncQueue();
  queue.push({ table, op, payload, queuedAt: Date.now() });
  saveSyncQueue(queue);
}

// --- Executes a single queued/immediate operation against Supabase ---
async function runSupabaseOp(table, op, payload) {
  if (!sb) throw new Error("Supabase client not available");

  if (op === "upsert") {
    const { error } = await sb.from(table).upsert(payload.rows);
    if (error) throw error;
  } else if (op === "delete") {
    if (!payload.ids || !payload.ids.length) return;
    const { error } = await sb.from(table).delete().in("id", payload.ids);
    if (error) throw error;
  } else if (op === "deleteWhere") {
    let query = sb.from(table).delete();
    Object.entries(payload.match || {}).forEach(([col, val]) => {
      query = query.eq(col, val);
    });
    if (payload.inFilter) {
      query = query.in(payload.inFilter.column, payload.inFilter.values);
    }
    const { error } = await query;
    if (error) throw error;
  } else if (op === "replaceAll") {
    // Used for CSV/Excel import and full JSON restores: wipe the table, then
    // insert the freshly imported rows.
    const { error: delErr } = await sb.from(table).delete().not("id", "is", null);
    if (delErr) throw delErr;
    if (payload.rows && payload.rows.length) {
      const { error: insErr } = await sb.from(table).insert(payload.rows);
      if (insErr) throw insErr;
    }
  }
}

// --- Public sync entry point: try immediately, queue on any failure ---
async function syncToSupabase(table, op, payload) {
  if (!sb || typeof navigator !== "undefined" && navigator.onLine === false) {
    enqueueSync(table, op, payload);
    return;
  }
  try {
    await runSupabaseOp(table, op, payload);
  } catch (err) {
    console.warn(`Supabase sync failed for ${table}/${op}, queued for retry:`, err);
    enqueueSync(table, op, payload);
  }
}

// --- Flushes any queued offline changes, in order, stopping at the first failure ---
let isFlushingQueue = false;
async function flushSyncQueue() {
  if (!sb || isFlushingQueue) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  const queue = loadSyncQueue();
  if (!queue.length) return;

  isFlushingQueue = true;
  let remaining = [...queue];

  while (remaining.length) {
    const op = remaining[0];
    try {
      await runSupabaseOp(op.table, op.op, op.payload);
      remaining.shift();
      saveSyncQueue(remaining);
    } catch (err) {
      console.warn("Still offline or sync error, will retry later:", err);
      break;
    }
  }

  isFlushingQueue = false;
}

// --- Pulls fresh data from Supabase and replaces local state (used on startup) ---
async function pullFromSupabase() {
  if (!sb || (typeof navigator !== "undefined" && navigator.onLine === false)) return false;

  try {
    const [suppliersRes, stocksRes, ordersRes] = await Promise.all([
      sb.from("suppliers").select("*"),
      sb.from("stocks").select("*"),
      sb.from("orders").select("*")
    ]);

    if (suppliersRes.error) throw suppliersRes.error;
    if (stocksRes.error) throw stocksRes.error;
    if (ordersRes.error) throw ordersRes.error;

    state = {
      suppliers: (suppliersRes.data || []).map(supplierFromDb),
      stocks: (stocksRes.data || []).map(stockFromDb),
      order: (ordersRes.data || []).map(orderFromDb)
    };
    saveState();
    return true;
  } catch (err) {
    console.warn("Could not pull from Supabase, using local data:", err);
    return false;
  }
}

// --- Pushes the CURRENT local data up to Supabase (parents before children) ---
// Used the very first time this device connects to a Supabase project that
// doesn't have any data yet, so we never overwrite real local data with an
// empty remote table.
async function pushAllLocalDataToSupabase() {
  if (state.suppliers.length) {
    await syncToSupabase("suppliers", "upsert", { rows: state.suppliers.map(supplierToDb) });
  }
  if (state.stocks.length) {
    await syncToSupabase("stocks", "upsert", { rows: state.stocks.map(stockToDb) });
  }
  if (state.order.length) {
    await syncToSupabase("orders", "upsert", { rows: state.order.map(orderToDb) });
  }
}

// --- On startup: push queued offline changes, then decide push-vs-pull ---
const INITIAL_SEED_DONE_KEY = "shop-stock-order-app-initial-seed-done-v1";

async function syncOnStartup() {
  if (!sb) return;
  await flushSyncQueue();

  const alreadySeeded = localStorage.getItem(INITIAL_SEED_DONE_KEY) === "true";
  const hasLocalData =
    !isUsingDemoData &&
    (state.suppliers.length > 0 || state.stocks.length > 0 || state.order.length > 0);

  if (!alreadySeeded && hasLocalData) {
    try {
      const { count, error } = await sb.from("suppliers").select("*", { count: "exact", head: true });
      const remoteIsEmpty = !error && (count || 0) === 0;

      if (remoteIsEmpty) {
        // First time this device has connected to Supabase: push local data up
        // rather than pulling the empty remote tables and wiping it out.
        await pushAllLocalDataToSupabase();
        localStorage.setItem(INITIAL_SEED_DONE_KEY, "true");
        return;
      }
    } catch (err) {
      console.warn("Could not check remote data before initial sync:", err);
      return; // stay on local data rather than risk overwriting it
    }
  }

  localStorage.setItem(INITIAL_SEED_DONE_KEY, "true");
  const pulled = await pullFromSupabase();
  if (pulled) render();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    flushSyncQueue().then(() => pullFromSupabase().then((pulled) => { if (pulled) render(); }));
  });
}

let currentStatusFilter = "active"; 
let focusedSupplierId = null;
let focusedBatchId = null;

let longPressTimer = null;
let isLongPressTriggered = false;
const LONG_PRESS_DURATION = 600;

let selectedQuickOrderItem = null;

const el = {
  stockForm: document.querySelector("#stockForm"),
  supplierForm: document.querySelector("#supplierForm"),
  orderForm: document.querySelector("#orderForm"),
  stockTable: document.querySelector("#stockTable"),
  supplierList: document.querySelector("#supplierList"),
  bifurcatedOrderContainer: document.querySelector("#bifurcatedOrderContainer"),
  orderItemSearchInput: document.querySelector("#orderItemSearchInput"),
  hiddenOrderItemId: document.querySelector("#hiddenOrderItemId"),
  searchSuggestionsBox: document.querySelector("#searchSuggestionsBox"),
  orderQty: document.querySelector("#orderQty"),
  supplierFilter: document.querySelector("#supplierFilter"),
  supplierFilterSuggestionsBox: document.querySelector("#supplierFilterSuggestionsBox"),
  stockSearch: document.querySelector("#stockSearch"),
  recentOrderAlert: document.querySelector("#recentOrderAlert"),
  stockSubmitBtn: document.querySelector("#stockSubmitBtn"),
  
  // Autocomplete Supplier Nodes
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
  tabButtons: document.querySelectorAll(".tab-button"),
  subTabButtons: document.querySelectorAll(".sub-tab-button"),
  subPageViews: document.querySelectorAll(".sub-page-view"),

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
    return {
      suppliers: parsed.suppliers || [],
      stocks: (parsed.stocks || []).map(normalizeStockItem),
      order: parsed.order || []
    };
  } catch {
    return emptyState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function supplierName(id) {
  return state.suppliers.find((supplier) => supplier.id === id)?.name || "No supplier";
}

function keepSelectValue(select, value) {
  if (select && [...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function formatUnit(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function clearInlineUnitLabel() {
  if (el.orderQtyInlineUnit) el.orderQtyInlineUnit.textContent = "";
}

function addOrUpdateOrderLine(item, qty) {
  const quantity = Math.max(1, Number(qty) || 1);
  const existingLine = state.order.find(
    (line) => line.itemId === item.id && (line.status || "active") === "active"
  );

  if (existingLine) {
    existingLine.quantity = Number(existingLine.quantity || 0) + quantity;
    syncToSupabase("orders", "upsert", { rows: [orderToDb(existingLine)] });
  } else {
    const newLine = {
      id: generateUUID(),
      itemId: item.id,
      supplierId: item.supplierId,
      quantity,
      status: "active",
      dateCreated: getFormattedDate()
    };
    state.order.push(newLine);
    syncToSupabase("orders", "upsert", { rows: [orderToDb(newLine)] });
  }
}

function toggleActiveCompletedState(supplierId, newStatus, batchId) {
  const changedLines = [];

  if (newStatus === "completed") {
    // Sending an order: every currently-active line for this supplier becomes
    // one new, distinct batch — so sending again later creates a separate
    // entry instead of merging into the same completed group.
    const newBatchId = generateUUID();
    state.order.forEach((line) => {
      if (line.supplierId === supplierId && (line.status || "active") !== "completed") {
        line.status = "completed";
        line.batchId = newBatchId;
        changedLines.push(line);
      }
    });
  } else {
    // Reverting to active: only un-complete the specific batch being viewed,
    // not every completed order this supplier has ever had.
    state.order.forEach((line) => {
      if (
        line.supplierId === supplierId &&
        (line.status || "active") === "completed" &&
        (line.batchId || "") === (batchId || "")
      ) {
        line.status = "active";
        line.batchId = null;
        changedLines.push(line);
      }
    });
  }

  saveState();
  if (changedLines.length) {
    syncToSupabase("orders", "upsert", { rows: changedLines.map(orderToDb) });
  }

  if (el.deepView) el.deepView.style.display = "none";
  if (el.masterView) el.masterView.style.display = "block";
  renderBifurcatedOrders();
}

function buildCleanTextPayload(supplierId) {
  const lines = state.order.filter(
    (line) => line.supplierId === supplierId && (line.status || "active") === currentStatusFilter
  );

  return lines
    .map((line) => {
      const item = state.stocks.find((s) => s.id === line.itemId);
      return `- ${item ? item.name : "Deleted item"}: ${formatNumber(line.quantity)} ${item?.unit || "pcs"}`;
    })
    .join("\n");
}

// Global filter state change tab handler
document.querySelectorAll("[data-status-filter]").forEach((pill) => {
  pill.addEventListener("click", () => {
    if(el.pillActive) el.pillActive.classList.toggle("active", pill.id === "pillActive");
    if(el.pillCompleted) el.pillCompleted.classList.toggle("active", pill.id === "pillCompleted");
    currentStatusFilter = pill.dataset.statusFilter;
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    renderBifurcatedOrders();
  });
});

function getFormattedDate() {
  return new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

// Formats any date value (a Supabase timestamp like "2026-06-21T08:30:00+00:00",
// or an already-nice string like "21 Jun 2026") into a clean date-only display.
function formatDisplayDate(value) {
  if (!value) return getFormattedDate();
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function normalizeStockItem(item) {
  return {
    id: item.id || generateUUID(),
    name: item.name || "",
    supplierId: item.supplierId || "",
    unit: formatUnit(item.unit)
  };
}

function render() {
  renderSupplierOptions();
  renderStockTable();
  renderSupplierList();
  renderBifurcatedOrders();
}

function showPage(pageId) {
  el.pages.forEach((page) => {
    const isActive = page.id === pageId;
    page.hidden = !isActive;
    page.classList.toggle("active", isActive);
  });

  el.tabButtons.forEach((button) => {
    const isActive = button.dataset.pageTarget === pageId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  if (pageId === "orderDetailsPage") {
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    
    if (el.masterView) el.masterView.classList.remove("selection-active");
    if (el.deepView) el.deepView.classList.remove("selection-active");
    
    renderBifurcatedOrders();
  }

  if (location.hash !== `#${pageId}`) {
    history.replaceState(null, "", `#${pageId}`);
  }
}

function showSubPage(subPageId) {
  el.subPageViews.forEach((view) => {
    view.hidden = view.id !== subPageId;
  });

  el.subTabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subTarget === subPageId);
  });

  // When switching away from the supplier sub-page, reset detail view
  if (subPageId !== "supplierSubPage") {
    closeSupplierStockDetail();
  }
}

function renderSupplierOptions() {
  // Supplier filter is now a text search box — nothing to render here.
  // The suggestions box is populated on demand by handleSupplierFilterSearch().
}

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
    el.stockTable.innerHTML = `<tr><td colspan="4" class="empty">No stock items found.</td></tr>`;
    return;
  }

  el.stockTable.innerHTML = visibleStocks
    .map((item) => `
      <tr class="stock-table-row" data-item-id="${item.id}" style="cursor: pointer; user-select: none; -webkit-user-select: none;">
        <td data-label="Item">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" class="stock-delete-checkbox" data-item-id="${item.id}"
              style="visibility: hidden; pointer-events: none; flex-shrink: 0; width: 16px; height: 16px; accent-color: #ff3b30;" />
            <div class="item-name">${escapeHtml(item.name)}</div>
          </div>
        </td>
        <td data-label="Supplier">${escapeHtml(supplierName(item.supplierId))}</td>
        <td data-label="Unit">${escapeHtml(item.unit || "pcs")}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <button class="icon-btn mini-icon-btn" type="button" data-action="edit-stock" data-id="${item.id}" title="Edit item">✏️</button>
          </div>
        </td>
      </tr>
    `).join("");

  setupStockTableLongPress();
}

// ---------- Stock table tap-and-hold delete ----------
let stockTableLongPressTimer = null;
let stockTableSelectionActive = false;

function setupStockTableLongPress() {
  el.stockTable.querySelectorAll(".stock-table-row").forEach((row) => {
    const onLongPress = () => {
      stockTableSelectionActive = true;
      el.stockTable.querySelectorAll(".stock-delete-checkbox").forEach((cb) => {
        cb.style.visibility = "visible";
        cb.style.pointerEvents = "auto";
      });
      showStockBulkDeleteBar();
      const cb = row.querySelector(".stock-delete-checkbox");
      if (cb) cb.checked = true;
      updateStockBulkDeleteBar();
    };

    let touchStartX = 0, touchStartY = 0;

    row.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      stockTableLongPressTimer = setTimeout(onLongPress, 600);
    });
    row.addEventListener("touchstart", (e) => {
      if (e.target.closest("button")) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      stockTableLongPressTimer = setTimeout(onLongPress, 600);
    }, { passive: true });
    row.addEventListener("touchmove", (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 8 || dy > 8) clearTimeout(stockTableLongPressTimer);
    }, { passive: true });
    row.addEventListener("mouseup", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("touchend", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("touchcancel", () => clearTimeout(stockTableLongPressTimer));
    row.addEventListener("mouseleave", () => clearTimeout(stockTableLongPressTimer));

    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (stockTableSelectionActive) {
        // in selection mode, tap toggles checkbox
        const cb = row.querySelector(".stock-delete-checkbox");
        if (cb) { cb.checked = !cb.checked; updateStockBulkDeleteBar(); }
        return;
      }
      // single tap in normal mode: no action (ordering is done from the Order List page)
    });
  });
}

function showStockBulkDeleteBar() {
  if (!el.stockBulkDeleteBar) return;
  el.stockBulkDeleteBar.style.display = "flex";
}

function hideStockBulkDeleteBar() {
  stockTableSelectionActive = false;
  if (!el.stockBulkDeleteBar) return;
  el.stockBulkDeleteBar.style.display = "none";
  el.stockTable.querySelectorAll(".stock-delete-checkbox").forEach((cb) => {
    cb.checked = false;
    cb.style.visibility = "hidden";
    cb.style.pointerEvents = "none";
  });
  if (el.stockBulkDeleteCount) el.stockBulkDeleteCount.textContent = "0 selected";
}

function updateStockBulkDeleteBar() {
  const checked = el.stockTable.querySelectorAll(".stock-delete-checkbox:checked").length;
  if (el.stockBulkDeleteCount) el.stockBulkDeleteCount.textContent = `${checked} selected`;
}


let expandedSupplierId = null; // kept for backwards compatibility, no longer used for expansion
let focusedSupplierDetailId = null;

function openSupplierStockDetail(supplierId) {
  focusedSupplierDetailId = supplierId;
  const supplier = state.suppliers.find(s => s.id === supplierId);
  if (!supplier) return;

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
  const items = state.stocks
    .filter(s => s.supplierId === focusedSupplierDetailId)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!items.length) {
    el.supplierStockDetailList.innerHTML = `<div class="empty">No stock items linked to this supplier yet.<br>Go to Stock Details to add some.</div>`;
    return;
  }

  el.supplierStockDetailList.innerHTML = items.map(item => `
    <div class="supplier-stock-item" data-item-id="${item.id}" style="
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
      background: #fff; margin-bottom: 6px; cursor: pointer;
      user-select: none; -webkit-user-select: none; overflow: hidden;">
      <div style="flex: 1 1 0; min-width: 0;">
        <strong style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.95rem;">${escapeHtml(item.name)}</strong>
        <span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(item.unit || "pcs")}</span>
      </div>
      <span style="flex-shrink: 0; color: var(--primary); font-size: 1rem;">➕</span>
    </div>
  `).join("");
}

function closeSupplierStockDetail() {
  focusedSupplierDetailId = null;
  if (el.supplierStockDetailView) el.supplierStockDetailView.style.display = "none";
  if (el.supplierMasterView) el.supplierMasterView.style.display = "block";
}

function renderSupplierList() {
  if (!el.supplierList) return;
  if (!state.suppliers.length) {
    el.supplierList.innerHTML = `<div class="empty">Add your first supplier above.</div>`;
    return;
  }

  const query = (el.supplierSearchInput?.value || "").trim().toLowerCase();
  const visibleSuppliers = (query
    ? state.suppliers.filter((supplier) => supplier.name.toLowerCase().includes(query))
    : [...state.suppliers]
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!visibleSuppliers.length) {
    el.supplierList.innerHTML = `<div class="empty">No suppliers match your search.</div>`;
    return;
  }

  el.supplierList.innerHTML = visibleSuppliers
    .map((supplier) => {
      return `
        <div class="supplier-card-row" data-supplier-id="${supplier.id}" style="
          display: flex; align-items: center; gap: 10px;
          border: 1px solid var(--line); border-radius: 8px;
          padding: 12px 14px; background: #fff; margin-bottom: 6px;
          cursor: pointer; user-select: none; -webkit-user-select: none; overflow: hidden;">
          <div style="flex: 1 1 0; min-width: 0; overflow: hidden;">
            <strong style="font-size: 1rem; display: block; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(supplier.name)}</strong>
            <div style="font-size: 0.82rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${supplier.phone ? escapeHtml(supplier.phone) : (supplier.email ? escapeHtml(supplier.email) : "No contact info")}
            </div>
          </div>
          <div style="flex-shrink: 0; display: flex; align-items: center; gap: 6px;">
              <button class="icon-btn" type="button" data-action="edit-supplier" data-id="${supplier.id}" style="padding: 0; min-height: 34px; width: 34px; font-size: 1rem;" title="Edit">✏️</button>
              <button class="icon-btn danger-soft" type="button" data-action="delete-supplier" data-id="${supplier.id}" style="padding: 0; min-height: 34px; width: 34px; font-size: 1rem;" title="Delete">🗑</button>
              <span style="color: var(--primary); font-size: 1.2rem; line-height: 1; padding-left: 4px;">›</span>
            </div>
        </div>
      `;
    }).join("");
}

function handleSearchInput() {
  if (!el.orderItemSearchInput || !el.searchSuggestionsBox) return;
  const query = el.orderItemSearchInput.value.trim().toLowerCase();

  const matches = (query
    ? state.stocks.filter((item) =>
        item.name.toLowerCase().includes(query) ||
        supplierName(item.supplierId).toLowerCase().includes(query)
      )
    : [...state.stocks]
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!state.stocks.length) {
    el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No stock items added yet. Go to Stock Details to add some.</div>`;
    el.searchSuggestionsBox.style.display = "block";
    return;
  }

  if (!matches.length) {
    el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No items match "${escapeHtml(query)}"</div>`;
    el.searchSuggestionsBox.style.display = "block";
    return;
  }

  el.searchSuggestionsBox.innerHTML = matches
    .map((item) => `
      <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="vendor-tag">${escapeHtml(supplierName(item.supplierId))}</span>
      </div>
    `).join("");
  el.searchSuggestionsBox.style.display = "block";
}

if (el.supplierList) {
  el.supplierList.addEventListener("click", (event) => {
    // Don't navigate if tapping Edit or Delete buttons
    if (event.target.closest("button[data-action]")) return;

    const row = event.target.closest(".supplier-card-row");
    if (row) {
      openSupplierStockDetail(row.dataset.supplierId);
    }
  });
}

if (el.supplierStockBackBtn) {
  el.supplierStockBackBtn.addEventListener("click", closeSupplierStockDetail);
}

if (el.supplierStockDetailList) {
  el.supplierStockDetailList.addEventListener("click", (event) => {
    const item = event.target.closest(".supplier-stock-item");
    if (!item) return;
    const stock = state.stocks.find(s => s.id === item.dataset.itemId);
    if (stock) openAddToOrderModal(stock);
  });
}

function handleStockSupplierSearch() {
  if (!el.stockSupplierSearchInput || !el.supplierSuggestionsBox) return;
  const query = el.stockSupplierSearchInput.value.trim().toLowerCase();

  const matches = (query
    ? state.suppliers.filter((supplier) => supplier.name.toLowerCase().includes(query))
    : [...state.suppliers]
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!state.suppliers.length) {
    el.supplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers added yet. Go to Supplier Details to add one.</div>`;
    el.supplierSuggestionsBox.style.display = "block";
    return;
  }

  if (!matches.length) {
    el.supplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers match "${escapeHtml(query)}"</div>`;
    el.supplierSuggestionsBox.style.display = "block";
    return;
  }

  el.supplierSuggestionsBox.innerHTML = matches
    .map((supplier) => `
      <div class="supplier-suggestion-item suggestion-item" data-id="${supplier.id}" data-name="${escapeHtml(supplier.name)}">
        <strong>${escapeHtml(supplier.name)}</strong>
      </div>
    `).join("");
  el.supplierSuggestionsBox.style.display = "block";
}

function handleSupplierListSearch() {
  if (!el.supplierSearchInput || !el.supplierSearchSuggestionsBox) return;
  const query = el.supplierSearchInput.value.trim().toLowerCase();

  const matches = (query
    ? state.suppliers.filter(s => s.name.toLowerCase().includes(query))
    : [...state.suppliers]
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!state.suppliers.length) {
    el.supplierSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers added yet.</div>`;
    el.supplierSearchSuggestionsBox.style.display = "block";
    return;
  }

  if (!matches.length) {
    el.supplierSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers match "${escapeHtml(query)}"</div>`;
    el.supplierSearchSuggestionsBox.style.display = "block";
    return;
  }

  el.supplierSearchSuggestionsBox.innerHTML = matches
    .map((supplier) => `
      <div class="suggestion-item" data-id="${supplier.id}" data-name="${escapeHtml(supplier.name)}">
        <strong>${escapeHtml(supplier.name)}</strong>
      </div>
    `).join("");
  el.supplierSearchSuggestionsBox.style.display = "block";
}

function handleStockSearchInput() {
  if (!el.stockSearch || !el.stockSearchSuggestionsBox) return;
  const query = el.stockSearch.value.trim().toLowerCase();

  const matches = (query
    ? state.stocks.filter((item) =>
        item.name.toLowerCase().includes(query) ||
        supplierName(item.supplierId).toLowerCase().includes(query)
      )
    : [...state.stocks]
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!state.stocks.length) {
    el.stockSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No stock items added yet.</div>`;
    el.stockSearchSuggestionsBox.style.display = "block";
    return;
  }

  if (!matches.length) {
    el.stockSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No items match "${escapeHtml(query)}"</div>`;
    el.stockSearchSuggestionsBox.style.display = "block";
    return;
  }

  el.stockSearchSuggestionsBox.innerHTML = matches
    .map((item) => `
      <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="vendor-tag">${escapeHtml(supplierName(item.supplierId))}</span>
      </div>
    `).join("");
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

  if (el.stockQuickOrderQty) {
    el.stockQuickOrderQty.value = 1;
    el.stockQuickOrderQty.focus();
    el.stockQuickOrderQty.select();
  }
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
  
  const targetLines = state.order.filter((line) => (line.status || "active") === currentStatusFilter);
  
  if (!targetLines.length) {
    el.bifurcatedOrderContainer.innerHTML = `<div class="empty">No ${currentStatusFilter} orders currently in register logs.</div>`;
    return;
  }

  if (currentStatusFilter === "completed") {
    // Group by supplier + batch, so each separate "send" shows as its own
    // entry instead of merging into one ongoing bucket per supplier.
    const groups = new Map();
    targetLines.forEach((line) => {
      const batchKey = line.batchId || "";
      const groupKey = `${line.supplierId}::${batchKey}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { supplierId: line.supplierId, batchId: batchKey, lines: [] });
      }
      groups.get(groupKey).lines.push(line);
    });

    const sortedGroups = [...groups.values()].sort((a, b) => {
      const dateA = new Date(a.lines[0].dateCreated || 0).getTime();
      const dateB = new Date(b.lines[0].dateCreated || 0).getTime();
      return dateB - dateA; // most recent first
    });

    el.bifurcatedOrderContainer.innerHTML = sortedGroups
      .map(({ supplierId: sId, batchId, lines }) => {
        const vendorLabel = supplierName(sId);
        const dateLabel = formatDisplayDate(lines[0].dateCreated);

        return `
          <div class="single-line-row" data-supplier-id="${sId}" data-batch-id="${escapeHtml(batchId)}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0;">
            <div class="vendor-title-wrapper">
              <input type="checkbox" class="master-multi-delete-checkbox" data-supplier-id="${sId}" data-batch-id="${escapeHtml(batchId)}">
              <div style="display: flex; flex-direction: column; min-width: 0; overflow: hidden;">
                <span class="vendor-title">${escapeHtml(vendorLabel)}</span>
                <span class="subtle" style="font-size: 0.78rem;">${escapeHtml(dateLabel)}</span>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0;">
              <span class="badge-count">${lines.length} Item${lines.length === 1 ? '' : 's'}</span>
            </div>
          </div>
        `;
      }).join("");

    bindMasterCheckboxListeners();
    setupMasterLongPressTriggers(); 
    return;
  }

  // Active tab: still grouped purely by supplier — items added at different
  // times stay together as one draft until they're actually sent.
  const uniqueSuppliers = [...new Set(targetLines.map(line => line.supplierId))];

  el.bifurcatedOrderContainer.innerHTML = uniqueSuppliers
    .map((sId) => {
      const vendorLabel = supplierName(sId);
      const sLinesCount = targetLines.filter(line => line.supplierId === sId).length;

      return `
        <div class="single-line-row" data-supplier-id="${sId}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0;">
          <div class="vendor-title-wrapper">
            <span class="vendor-title">${escapeHtml(vendorLabel)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0;">
            <span class="badge-count">${sLinesCount} Item${sLinesCount === 1 ? '' : 's'}</span>
          </div>
        </div>
      `;
    }).join("");
}

function setupMasterLongPressTriggers() {
  const rows = el.bifurcatedOrderContainer.querySelectorAll(".single-line-row");
  rows.forEach(row => {
    row.addEventListener("mousedown", (e) => startMasterLongPress(e, row));
    row.addEventListener("mouseup", cancelMasterLongPress);
    row.addEventListener("mouseleave", cancelMasterLongPress);
    
    let masterTouchStartX = 0, masterTouchStartY = 0;
    row.addEventListener("touchstart", (e) => {
      masterTouchStartX = e.touches[0].clientX;
      masterTouchStartY = e.touches[0].clientY;
      startMasterLongPress(e, row);
    }, { passive: true });
    row.addEventListener("touchmove", (e) => {
      const dx = Math.abs(e.touches[0].clientX - masterTouchStartX);
      const dy = Math.abs(e.touches[0].clientY - masterTouchStartY);
      if (dx > 8 || dy > 8) cancelMasterLongPress();
    }, { passive: true });
    row.addEventListener("touchend", cancelMasterLongPress);
    row.addEventListener("touchcancel", cancelMasterLongPress);
  });
}

function startMasterLongPress(e, row) {
  if (currentStatusFilter !== 'completed') return;
  if (e.target.closest('.master-multi-delete-checkbox')) return;

  isLongPressTriggered = false;
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true;
    if (el.masterView) el.masterView.classList.add("selection-active");
    const check = row.querySelector(".master-multi-delete-checkbox");
    if (check) check.checked = !check.checked;
    updateMasterBulkDeleteToolbarState();
    
    if (navigator.vibrate) navigator.vibrate(50); 
  }, LONG_PRESS_DURATION);
}

function cancelMasterLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
}

if (el.bifurcatedOrderContainer) {
  el.bifurcatedOrderContainer.addEventListener("click", (event) => {
    if (isLongPressTriggered) {
      isLongPressTriggered = false;
      return;
    }

    if (event.target.classList.contains("master-multi-delete-checkbox")) {
      return;
    }

    if (el.masterView && el.masterView.classList.contains("selection-active")) {
      const targetCheckbox = event.target.closest(".single-line-row")?.querySelector(".master-multi-delete-checkbox");
      if (targetCheckbox) {
        targetCheckbox.checked = !targetCheckbox.checked;
        updateMasterBulkDeleteToolbarState();
      }
      return;
    }

    const targetRow = event.target.closest(".single-line-row");
    if (!targetRow) return;
    openSupplierDeepView(targetRow.dataset.supplierId, targetRow.dataset.batchId);
  });
}

function setupDeepViewLongPressTriggers() {
  const cards = el.deepViewLinesList.querySelectorAll(".order-card");
  cards.forEach(card => {
    card.addEventListener("mousedown", (e) => startDeepLongPress(e, card));
    card.addEventListener("mouseup", cancelDeepLongPress);
    card.addEventListener("mouseleave", cancelDeepLongPress);
    
    let deepTouchStartX = 0, deepTouchStartY = 0;
    card.addEventListener("touchstart", (e) => {
      deepTouchStartX = e.touches[0].clientX;
      deepTouchStartY = e.touches[0].clientY;
      startDeepLongPress(e, card);
    }, { passive: true });
    card.addEventListener("touchmove", (e) => {
      const dx = Math.abs(e.touches[0].clientX - deepTouchStartX);
      const dy = Math.abs(e.touches[0].clientY - deepTouchStartY);
      if (dx > 8 || dy > 8) cancelDeepLongPress();
    }, { passive: true });
    card.addEventListener("touchend", cancelDeepLongPress);
    card.addEventListener("touchcancel", cancelDeepLongPress);
  });
}

function startDeepLongPress(e, card) {
  if (currentStatusFilter !== 'active') return;
  if (e.target.closest('.multi-delete-checkbox') || e.target.closest('button[data-action]')) return;

  isLongPressTriggered = false;
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true;
    if (el.deepView) el.deepView.classList.add("selection-active");
    const check = card.querySelector(".multi-delete-checkbox");
    if (check) check.checked = true;
    updateBulkDeleteToolbarState();
    
    if (navigator.vibrate) navigator.vibrate(50);
  }, LONG_PRESS_DURATION);
}

function cancelDeepLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
}

// ---------- Quantity modal (dual mode: add-to-order or edit-existing-line) ----------
let editingQtyLineId = null;   // set when editing an existing line
let addingOrderItemId = null;  // set when adding a new line from a stock tap
let alreadyInListLineId = null; // holds the existing line if already-in-list dialog is showing

function openAddToOrderModal(item) {
  // Check if this item is already in the active order — show info dialog if so
  const existingLine = state.order.find(
    (l) => l.itemId === item.id && (l.status || "active") === "active"
  );

  if (existingLine) {
    // Show the "already in list" dialog instead of the add form
    alreadyInListLineId = existingLine.id;
    if (el.alreadyInListTitle) el.alreadyInListTitle.textContent = "Already in Order";
    if (el.alreadyInListBody) {
      el.alreadyInListBody.innerHTML = `
        <strong>${escapeHtml(item.name)}</strong> is already in your active order list.<br><br>
        Current quantity: <strong>${existingLine.quantity} ${escapeHtml(item.unit || "pcs")}</strong><br><br>
        Would you like to edit the quantity?
      `;
    }
    if (el.alreadyInListModal) el.alreadyInListModal.style.display = "flex";
    return;
  }

  // Item not in active order — open the normal add form
  editingQtyLineId = null;
  addingOrderItemId = item.id;

  if (el.editQtyModalTitle) el.editQtyModalTitle.textContent = "Add to Order";
  if (el.editQtySaveBtn) el.editQtySaveBtn.textContent = "Add";
  if (el.editQtyItemName) el.editQtyItemName.textContent = `${item.name} (${item.unit || "pcs"})`;
  if (el.editQtyInput) el.editQtyInput.value = 1;
  if (el.editQtyModal) el.editQtyModal.style.display = "flex";
  setTimeout(() => {
    if (el.editQtyInput) { el.editQtyInput.focus(); el.editQtyInput.select(); }
  }, 50);
}

// ---------- Reusable confirm modal ----------
// Usage: const yes = await showConfirm("Title", "Message", "Button label");
let _confirmResolve = null;

function showConfirm(title, body, okLabel = "Delete", okDanger = true) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    if (el.confirmModalTitle) el.confirmModalTitle.textContent = title;
    if (el.confirmModalBody) el.confirmModalBody.textContent = body;
    if (el.confirmModalOkBtn) {
      el.confirmModalOkBtn.textContent = okLabel;
      el.confirmModalOkBtn.style.background = okDanger ? "var(--danger)" : "var(--primary)";
    }
    if (el.confirmModal) el.confirmModal.style.display = "flex";
  });
}

function _closeConfirmModal(result) {
  if (el.confirmModal) el.confirmModal.style.display = "none";
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

if (el.confirmModalOkBtn) el.confirmModalOkBtn.addEventListener("click", () => _closeConfirmModal(true));
if (el.confirmModalCancelBtn) el.confirmModalCancelBtn.addEventListener("click", () => _closeConfirmModal(false));
if (el.confirmModal) {
  el.confirmModal.addEventListener("click", (e) => {
    if (e.target === el.confirmModal) _closeConfirmModal(false);
  });
}

function closeAlreadyInListModal() {
  alreadyInListLineId = null;
  if (el.alreadyInListModal) el.alreadyInListModal.style.display = "none";
}

if (el.alreadyInListNoBtn) {
  el.alreadyInListNoBtn.addEventListener("click", closeAlreadyInListModal);
}

if (el.alreadyInListEditBtn) {
  el.alreadyInListEditBtn.addEventListener("click", () => {
    const line = state.order.find((l) => l.id === alreadyInListLineId);
    if (!line) { closeAlreadyInListModal(); return; }
    const item = state.stocks.find((s) => s.id === line.itemId);
    closeAlreadyInListModal();
    // Open the edit modal for this existing line
    openEditQtyModal(line, item);
  });
}

if (el.alreadyInListModal) {
  el.alreadyInListModal.addEventListener("click", (event) => {
    if (event.target === el.alreadyInListModal) closeAlreadyInListModal();
  });
}

// ---------- Edit Stock Modal ----------
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

// ---------- Quick Add Supplier Modal ----------
// Opened from the + button in the supplier search fields on the Add/Edit Stock forms.
// After saving, auto-selects the new supplier in whichever search field triggered it.

let _quickAddSupplierCallerSearchInput = null;
let _quickAddSupplierCallerHiddenInput = null;

function openQuickAddSupplierModal(searchInput, hiddenInput) {
  _quickAddSupplierCallerSearchInput = searchInput;
  _quickAddSupplierCallerHiddenInput = hiddenInput;

  // Pre-fill the name with whatever the user already typed in the search box
  const prefill = searchInput?.value.trim() || "";
  if (el.quickSupplierName) el.quickSupplierName.value = prefill;
  if (el.quickSupplierEmail) el.quickSupplierEmail.value = "";
  if (el.quickSupplierPhone) el.quickSupplierPhone.value = "";
  if (el.quickAddSupplierModal) el.quickAddSupplierModal.style.display = "flex";
  setTimeout(() => { if (el.quickSupplierName) el.quickSupplierName.focus(); }, 50);
}

function closeQuickAddSupplierModal() {
  if (el.quickAddSupplierModal) el.quickAddSupplierModal.style.display = "none";
  _quickAddSupplierCallerSearchInput = null;
  _quickAddSupplierCallerHiddenInput = null;
}

function saveQuickAddSupplierModal() {
  const name = el.quickSupplierName?.value.trim();
  const email = el.quickSupplierEmail?.value.trim() || "";
  const phone = (el.quickSupplierPhone?.value.trim() || "").replace(/[^0-9+]/g, "");

  if (!name) {
    showConfirm("Missing Name", "Please enter a supplier name.", "OK", false);
    return;
  }

  // Duplicate check
  const duplicate = state.suppliers.find(
    s => s.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    // Already exists — just select it in the calling field
    if (_quickAddSupplierCallerSearchInput) _quickAddSupplierCallerSearchInput.value = duplicate.name;
    if (_quickAddSupplierCallerHiddenInput) _quickAddSupplierCallerHiddenInput.value = duplicate.id;
    closeQuickAddSupplierModal();
    return;
  }

  const newSupplier = { id: generateUUID(), name, email, phone };
  state.suppliers.push(newSupplier);
  saveState();
  syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(newSupplier)] });
  renderSupplierOptions();
  renderSupplierList();

  // Auto-select the new supplier in whichever search field triggered the modal
  if (_quickAddSupplierCallerSearchInput) _quickAddSupplierCallerSearchInput.value = newSupplier.name;
  if (_quickAddSupplierCallerHiddenInput) _quickAddSupplierCallerHiddenInput.value = newSupplier.id;

  closeQuickAddSupplierModal();
}

if (el.quickAddSupplierSaveBtn) el.quickAddSupplierSaveBtn.addEventListener("click", saveQuickAddSupplierModal);
if (el.quickAddSupplierCancelBtn) el.quickAddSupplierCancelBtn.addEventListener("click", closeQuickAddSupplierModal);
if (el.quickAddSupplierModal) {
  el.quickAddSupplierModal.addEventListener("click", (e) => {
    if (e.target === el.quickAddSupplierModal) closeQuickAddSupplierModal();
  });
}
if (el.quickSupplierName) {
  el.quickSupplierName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveQuickAddSupplierModal(); }
  });
}

// Wire the + buttons to the modal
if (el.quickAddSupplierBtn) {
  el.quickAddSupplierBtn.addEventListener("click", () => {
    openQuickAddSupplierModal(
      document.querySelector("#stockSupplierSearchInput"),
      document.querySelector("#hiddenStockSupplierId")
    );
  });
}

if (el.editStockQuickAddSupplierBtn) {
  el.editStockQuickAddSupplierBtn.addEventListener("click", () => {
    openQuickAddSupplierModal(el.editStockSupplierSearch, el.editStockHiddenSupplierId);
  });
}

function closeEditStockModal() {
  editingStockModalId = null;
  if (el.editStockModal) el.editStockModal.style.display = "none";
  if (el.editStockSupplierSuggestionsBox) el.editStockSupplierSuggestionsBox.style.display = "none";
}

function saveEditStockModal() {
  const name = el.editStockName?.value.trim();
  const supplierId = el.editStockHiddenSupplierId?.value;
  const unit = formatUnit(el.editStockUnit?.value);

  if (!name) {
    showConfirm("Missing Name", "Please enter an item name.", "OK", false);
    return;
  }
  if (!supplierId) {
    showConfirm("Missing Supplier", "Please select a supplier from the list.", "OK", false);
    return;
  }

  // Duplicate check — another item with the same name already exists (exclude the one being edited)
  const duplicate = state.stocks.find(
    s => s.id !== editingStockModalId && s.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    showConfirm(
      "Name Already Exists",
      `"${name}" is already in your stock list.\n\nPlease use a different name for this item.`,
      "OK",
      false
    );
    return;
  }

  const item = state.stocks.find(s => s.id === editingStockModalId);
  if (!item) { closeEditStockModal(); return; }

  item.name = name;
  item.supplierId = supplierId;
  item.unit = unit;
  saveState();
  syncToSupabase("stocks", "upsert", { rows: [stockToDb(item)] });
  closeEditStockModal();
  render();
}

if (el.editStockSaveBtn) el.editStockSaveBtn.addEventListener("click", saveEditStockModal);
if (el.editStockCancelBtn) el.editStockCancelBtn.addEventListener("click", closeEditStockModal);
if (el.editStockModal) {
  el.editStockModal.addEventListener("click", (e) => { if (e.target === el.editStockModal) closeEditStockModal(); });
}

// Supplier autocomplete inside the edit stock modal
if (el.editStockSupplierSearch) {
  const showEditStockSuppliers = () => {
    const query = el.editStockSupplierSearch.value.trim().toLowerCase();
    const matches = (query
      ? state.suppliers.filter(s => s.name.toLowerCase().includes(query))
      : [...state.suppliers]
    ).sort((a, b) => a.name.localeCompare(b.name));

    if (!matches.length) {
      el.editStockSupplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No matches</div>`;
    } else {
      el.editStockSupplierSuggestionsBox.innerHTML = matches.map(s =>
        `<div class="suggestion-item supplier-suggestion-item" data-id="${s.id}" data-name="${escapeHtml(s.name)}">
          <strong>${escapeHtml(s.name)}</strong>
        </div>`
      ).join("");
    }
    el.editStockSupplierSuggestionsBox.style.display = "block";
  };

  el.editStockSupplierSearch.addEventListener("input", showEditStockSuppliers);
  el.editStockSupplierSearch.addEventListener("focus", showEditStockSuppliers);
}

if (el.editStockSupplierSuggestionsBox) {
  el.editStockSupplierSuggestionsBox.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".supplier-suggestion-item");
    if (!item) return;
    e.preventDefault();
    if (el.editStockSupplierSearch) el.editStockSupplierSearch.value = item.dataset.name;
    if (el.editStockHiddenSupplierId) el.editStockHiddenSupplierId.value = item.dataset.id;
    el.editStockSupplierSuggestionsBox.style.display = "none";
    // Supplier is now the last field — just close the dropdown
  });
}

// ---------- Edit Supplier Modal ----------
let editingSupplierModalId = null;

function openEditSupplierModal(supplier) {
  editingSupplierModalId = supplier.id;
  if (el.editSupplierName) el.editSupplierName.value = supplier.name;
  if (el.editSupplierEmail) el.editSupplierEmail.value = supplier.email || "";
  if (el.editSupplierPhone) el.editSupplierPhone.value = supplier.phone || "";
  if (el.editSupplierModal) el.editSupplierModal.style.display = "flex";
  setTimeout(() => { if (el.editSupplierName) el.editSupplierName.focus(); }, 50);
}

function closeEditSupplierModal() {
  editingSupplierModalId = null;
  if (el.editSupplierModal) el.editSupplierModal.style.display = "none";
}

function saveEditSupplierModal() {
  const name = el.editSupplierName?.value.trim();
  const email = el.editSupplierEmail?.value.trim();
  const phone = (el.editSupplierPhone?.value.trim() || "").replace(/[^0-9+]/g, "");

  if (!name) { alert("Please enter a supplier name."); return; }

  const supplier = state.suppliers.find(s => s.id === editingSupplierModalId);
  if (!supplier) { closeEditSupplierModal(); return; }

  supplier.name = name;
  supplier.email = email;
  supplier.phone = phone;
  saveState();
  syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(supplier)] });
  closeEditSupplierModal();
  render();
}

if (el.editSupplierSaveBtn) el.editSupplierSaveBtn.addEventListener("click", saveEditSupplierModal);
if (el.editSupplierCancelBtn) el.editSupplierCancelBtn.addEventListener("click", closeEditSupplierModal);
if (el.editSupplierModal) {
  el.editSupplierModal.addEventListener("click", (e) => { if (e.target === el.editSupplierModal) closeEditSupplierModal(); });
}

function openEditQtyModal(line, item) {
  // "Edit Quantity" mode — opened by tapping ✏️ on an active order card
  addingOrderItemId = null;
  editingQtyLineId = line.id;

  if (el.editQtyModalTitle) el.editQtyModalTitle.textContent = "Edit Quantity";
  if (el.editQtySaveBtn) el.editQtySaveBtn.textContent = "Save";
  if (el.editQtyItemName) el.editQtyItemName.textContent = `${item?.name || "Deleted item"} (${item?.unit || "pcs"})`;
  if (el.editQtyInput) el.editQtyInput.value = line.quantity;
  if (el.editQtyModal) el.editQtyModal.style.display = "flex";
  setTimeout(() => {
    if (el.editQtyInput) { el.editQtyInput.focus(); el.editQtyInput.select(); }
  }, 50);
}

function closeEditQtyModal() {
  editingQtyLineId = null;
  addingOrderItemId = null;
  if (el.editQtyModal) el.editQtyModal.style.display = "none";
}

function saveEditQtyModal() {
  const qty = Math.max(1, Number(el.editQtyInput?.value) || 0);
  if (!qty) { alert("Please enter a valid quantity."); return; }

  if (addingOrderItemId) {
    // Add-to-order mode
    const item = state.stocks.find((s) => s.id === addingOrderItemId);
    if (!item) { closeEditQtyModal(); return; }
    addOrUpdateOrderLine(item, qty);
    saveState();
    closeEditQtyModal();
    return;
  }

  if (editingQtyLineId) {
    // Edit-existing-line mode
    const line = state.order.find((l) => l.id === editingQtyLineId);
    if (!line) { closeEditQtyModal(); return; }
    line.quantity = qty;
    saveState();
    syncToSupabase("orders", "upsert", { rows: [orderToDb(line)] });
    closeEditQtyModal();
    // Only navigate back into the deep view if we're actually in the order details page
    if (focusedSupplierId && el.deepView && el.deepView.style.display !== "none") {
      openSupplierDeepView(focusedSupplierId, focusedBatchId);
    }
  }
}

if (el.editQtySaveBtn) el.editQtySaveBtn.addEventListener("click", saveEditQtyModal);
if (el.editQtyCancelBtn) el.editQtyCancelBtn.addEventListener("click", closeEditQtyModal);

if (el.editQtyInput) {
  el.editQtyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); saveEditQtyModal(); }
    else if (event.key === "Escape") { closeEditQtyModal(); }
  });
}

if (el.editQtyModal) {
  el.editQtyModal.addEventListener("click", (event) => {
    if (event.target === el.editQtyModal) closeEditQtyModal();
  });
}

function bindMasterCheckboxListeners() {
  const checkboxes = el.bifurcatedOrderContainer.querySelectorAll(".master-multi-delete-checkbox");
  checkboxes.forEach(box => {
    box.addEventListener("change", updateMasterBulkDeleteToolbarState);
  });
}

function updateMasterBulkDeleteToolbarState() {
  const selectedBoxes = el.bifurcatedOrderContainer.querySelectorAll(".master-multi-delete-checkbox:checked");
  const count = selectedBoxes.length;

  if (count > 0 && currentStatusFilter === "completed") {
    el.masterBulkDeleteCountLabel.textContent = `${count} order${count === 1 ? "" : "s"} selected`;
    el.masterBulkDeleteToolbar.style.display = "flex";
  } else {
    el.masterBulkDeleteToolbar.style.display = "none";
    if (el.masterView) el.masterView.classList.remove("selection-active"); 
  }
}

function openSupplierDeepView(supplierId, batchId) {
  focusedSupplierId = supplierId;
  focusedBatchId = currentStatusFilter === "completed" ? (batchId || "") : null;
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
    renderBifurcatedOrders();
    return;
  }

  if (el.deepViewVendorTitle) el.deepViewVendorTitle.textContent = supplier ? supplier.name : "Supplier";
  
  const dateStr = formatDisplayDate(filteredLines[0].dateCreated);
  if (el.deepViewDateLabel) el.deepViewDateLabel.textContent = `Date: ${dateStr}`;

  if (el.toggleStatusStateBtn) {
    if (currentStatusFilter === "completed") {
      if (el.deepViewActionsContainer) el.deepViewActionsContainer.style.display = "none";
      el.toggleStatusStateBtn.textContent = "Move to Active";
      el.toggleStatusStateBtn.classList.add("revert-mode");
    } else {
      if (el.deepViewActionsContainer) el.deepViewActionsContainer.style.display = "flex";
      el.toggleStatusStateBtn.textContent = "Move to Completed";
      el.toggleStatusStateBtn.classList.remove("revert-mode");
    }
  }

  if (el.bulkDeleteToolbar) el.bulkDeleteToolbar.style.display = "none";
  if (el.deepView) el.deepView.classList.remove("selection-active");

  if (el.deepViewLinesList) {
    el.deepViewLinesList.innerHTML = filteredLines
      .map((line) => {
        const item = state.stocks.find(s => s.id === line.itemId);
        return `
          <div class="order-card" style="background: #fff; border: 1px solid var(--line); padding: 10px; margin-bottom: 6px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; min-width: 0; gap: 10px;">
            ${currentStatusFilter === 'active' ? `<input type="checkbox" class="multi-delete-checkbox" data-line-id="${line.id}">` : ''}
            
            <div style="min-width: 0; flex: 1 1 auto; margin-left: 2px; overflow: hidden;">
              <strong style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item?.name || "Deleted item")}</strong>
              <div class="order-meta" style="font-size: 0.85rem; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Qty: ${formatNumber(line.quantity)} ${escapeHtml(item?.unit || "pcs")}</div>
            </div>
            
            ${currentStatusFilter === 'active' ? `
              <button class="icon-btn" type="button" data-action="edit-deep-line" data-line-id="${line.id}" title="Edit quantity" style="min-width: 32px; min-height: 32px; height: 32px; width: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 6px; border: 1px solid var(--line); background:#fff; font-size: 15px;">
                ✏️
              </button>
            ` : ''}
          </div>
        `;
      }).join("");

    bindCheckboxListeners();
    setupDeepViewLongPressTriggers(); 
  }

  if (el.masterView) el.masterView.style.display = "none";
  if (el.deepView) el.deepView.style.display = "block";
}

function bindCheckboxListeners() {
  const checkboxes = el.deepViewLinesList.querySelectorAll(".multi-delete-checkbox");
  checkboxes.forEach(box => {
    box.addEventListener("change", updateBulkDeleteToolbarState);
  });
}

function updateBulkDeleteToolbarState() {
  const selectedBoxes = el.deepViewLinesList.querySelectorAll(".multi-delete-checkbox:checked");
  const count = selectedBoxes.length;

  if (count > 0 && currentStatusFilter === "active") {
    el.bulkDeleteCountLabel.textContent = `${count} item${count === 1 ? "" : "s"} selected`;
    el.bulkDeleteToolbar.style.display = "flex";
  } else {
    el.bulkDeleteToolbar.style.display = "none";
    if (el.deepView) el.deepView.classList.remove("selection-active");
  }
}

document.addEventListener("click", async (event) => {
  if (isLongPressTriggered) {
    isLongPressTriggered = false;
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;

  if (action === "remove-line") {
    if (await showConfirm("Remove Item", "Are you sure you want to permanently delete this order item?")) {
      state.order = state.order.filter((line) => line.id !== id);
      saveState();
      syncToSupabase("orders", "delete", { ids: [id] });
      render();
    }
  }

  if (action === "edit-deep-line") {
    const lineId = button.dataset.lineId;
    const line = state.order.find((l) => l.id === lineId);
    if (!line) return;

    const item = state.stocks.find((s) => s.id === line.itemId);
    openEditQtyModal(line, item);
  }

  if (action === "edit-supplier") {
    const supplier = state.suppliers.find((s) => s.id === id);
    if (supplier) openEditSupplierModal(supplier);
  }

  if (action === "delete-supplier") {
    const supplier = state.suppliers.find(s => s.id === id);
    if (!supplier) return;

    const supplierStockIds = state.stocks.filter(s => s.supplierId === id).map(s => s.id);
    const ordersCount = supplierStockIds.filter(stockId =>
      state.order.some(line => line.itemId === stockId)
    ).length;

    if (ordersCount > 0) {
      // Block — items are still in orders
      await showConfirm(
        "Cannot Delete Supplier",
        `${ordersCount} stock item${ordersCount === 1 ? "" : "s"} from this supplier ${ordersCount === 1 ? "is" : "are"} still present in your orders.\n\nPlease remove ${ordersCount === 1 ? "it" : "them"} from your Active or Completed orders first, then delete the stock items from Stock Details, and then you can delete this supplier.`,
        "OK",
        false
      );
      return;
    }

    if (supplierStockIds.length) {
      // Block — supplier still has stock items (none in orders, but must be cleared first)
      await showConfirm(
        "Cannot Delete Supplier",
        `This supplier has ${supplierStockIds.length} stock item${supplierStockIds.length === 1 ? "" : "s"} linked to them.\n\nPlease go to Stock Details, delete ${supplierStockIds.length === 1 ? "that item" : "those items"} first, and then you can delete this supplier.`,
        "OK",
        false
      );
      return;
    }

    // Safe to delete — no stock items at all
    if (!await showConfirm(
      "Delete Supplier",
      `Delete "${supplier.name}"? This cannot be undone.`
    )) return;

    state.suppliers = state.suppliers.filter((s) => s.id !== id);
    state.order = state.order.filter((line) => line.supplierId !== id);
    saveState();
    syncToSupabase("suppliers", "delete", { ids: [id] });
    render();
  }
});

if (el.backToMasterBtn) {
  el.backToMasterBtn.addEventListener("click", () => {
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    renderBifurcatedOrders();
  });
}

if (el.toggleStatusStateBtn) {
  el.toggleStatusStateBtn.addEventListener("click", async () => {
    if (!focusedSupplierId) return;
    if (currentStatusFilter === "active") {
      if (await showConfirm("Send Order", "Move this entire purchase list to completed orders?", "Move to Completed", false)) {
        toggleActiveCompletedState(focusedSupplierId, "completed");
      }
    } else {
      if (await showConfirm("Revert Order", "Move this entire purchase list back to active order lists?", "Move to Active", false)) {
        toggleActiveCompletedState(focusedSupplierId, "active", focusedBatchId);
      }
    }
  });
}

if (el.bulkDeleteExecuteBtn) {
  el.bulkDeleteExecuteBtn.addEventListener("click", async () => {
    const selectedBoxes = el.deepViewLinesList.querySelectorAll(".multi-delete-checkbox:checked");
    if (!selectedBoxes.length) return;

    if (await showConfirm(
      "Delete Items",
      `Remove these ${selectedBoxes.length} selected item${selectedBoxes.length === 1 ? "" : "s"} from your active order?`
    )) {
      const idsToDelete = Array.from(selectedBoxes).map(box => box.dataset.lineId);
      state.order = state.order.filter(line => !idsToDelete.includes(line.id));
      saveState();
      syncToSupabase("orders", "delete", { ids: idsToDelete });
      openSupplierDeepView(focusedSupplierId, focusedBatchId);
    }
  });
}

if (el.bulkDeleteCancelBtn) {
  el.bulkDeleteCancelBtn.addEventListener("click", () => {
    // Uncheck all, hide toolbar, exit selection mode
    if (el.deepViewLinesList) {
      el.deepViewLinesList.querySelectorAll(".multi-delete-checkbox").forEach(cb => {
        cb.checked = false;
      });
    }
    if (el.bulkDeleteToolbar) el.bulkDeleteToolbar.style.display = "none";
    if (el.deepView) el.deepView.classList.remove("selection-active");
  });
}

if (el.masterBulkDeleteExecuteBtn) {
  el.masterBulkDeleteExecuteBtn.addEventListener("click", async () => {
    const selectedBoxes = el.bifurcatedOrderContainer.querySelectorAll(".master-multi-delete-checkbox:checked");
    if (!selectedBoxes.length) return;

    if (await showConfirm(
      "Delete Completed Orders",
      `Permanently delete ${selectedBoxes.length} selected completed order${selectedBoxes.length === 1 ? "" : "s"}? This cannot be undone.`
    )) {
      const pairsToDelete = new Set(
        Array.from(selectedBoxes).map(box => `${box.dataset.supplierId}::${box.dataset.batchId || ""}`)
      );

      const idsToDelete = state.order
        .filter(line => line.status === "completed" && pairsToDelete.has(`${line.supplierId}::${line.batchId || ""}`))
        .map(line => line.id);

      state.order = state.order.filter(line => !idsToDelete.includes(line.id));
      saveState();
      syncToSupabase("orders", "delete", { ids: idsToDelete });
      renderBifurcatedOrders();
    }
  });
}

if (el.masterBulkDeleteCancelBtn) {
  el.masterBulkDeleteCancelBtn.addEventListener("click", () => {
    // Uncheck all, hide toolbar, exit selection mode
    if (el.bifurcatedOrderContainer) {
      el.bifurcatedOrderContainer.querySelectorAll(".master-multi-delete-checkbox").forEach(cb => {
        cb.checked = false;
      });
    }
    if (el.masterBulkDeleteToolbar) el.masterBulkDeleteToolbar.style.display = "none";
    if (el.masterView) el.masterView.classList.remove("selection-active");
    if (el.masterBulkDeleteCountLabel) el.masterBulkDeleteCountLabel.textContent = "0 orders selected";
  });
}


el.subTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => showSubPage(btn.dataset.subTarget));
});

if (el.searchSuggestionsBox) {
  el.searchSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;

    event.preventDefault();

    const selectedItem = state.stocks.find(s => s.id === suggestionItem.dataset.id);

    // Check if this item is already in the active order
    const existingLine = selectedItem
      ? state.order.find(l => l.itemId === selectedItem.id && (l.status || "active") === "active")
      : null;

    if (existingLine && selectedItem) {
      // Show the already-in-list popup instead of moving to quantity
      el.searchSuggestionsBox.style.display = "none";
      alreadyInListLineId = existingLine.id;
      if (el.alreadyInListTitle) el.alreadyInListTitle.textContent = "Already in Order";
      if (el.alreadyInListBody) {
        el.alreadyInListBody.innerHTML = `
          <strong>${escapeHtml(selectedItem.name)}</strong> is already in your active order list.<br><br>
          Current quantity: <strong>${existingLine.quantity} ${escapeHtml(selectedItem.unit || "pcs")}</strong><br><br>
          Would you like to edit the quantity?
        `;
      }
      if (el.alreadyInListModal) el.alreadyInListModal.style.display = "flex";
      return;
    }

    // Not a duplicate — proceed normally
    if (el.orderItemSearchInput) el.orderItemSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = suggestionItem.dataset.id;
    
    if (selectedItem && el.orderQtyInlineUnit) {
      el.orderQtyInlineUnit.textContent = selectedItem.unit || "pcs";
    }

    el.searchSuggestionsBox.style.display = "none";
    if (el.orderQty) {
      el.orderQty.focus();
      el.orderQty.select();
    }
  });
}

if (el.supplierSuggestionsBox) {
  el.supplierSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".supplier-suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;

    // Prevent the default mousedown behavior so the search input never
    // blurs mid-tap — that's what was letting the dropdown stay open.
    event.preventDefault();

    if (el.stockSupplierSearchInput) el.stockSupplierSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenStockSupplierId) el.hiddenStockSupplierId.value = suggestionItem.dataset.id;

    el.supplierSuggestionsBox.style.display = "none";
    // Supplier is now the last field — just close the dropdown, user can submit
  });
}

document.addEventListener("click", (event) => {
  if (el.searchSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.searchSuggestionsBox.style.display = "none";
  }
  if (el.supplierSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.supplierSuggestionsBox.style.display = "none";
  }
  if (el.stockSearchSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.stockSearchSuggestionsBox.style.display = "none";
  }
  if (el.supplierSearchSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.supplierSearchSuggestionsBox.style.display = "none";
  }
  if (el.supplierFilterSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.supplierFilterSuggestionsBox.style.display = "none";
  }
});

if (el.orderItemSearchInput) {
  el.orderItemSearchInput.addEventListener("input", () => {
    handleSearchInput();
  });
  el.orderItemSearchInput.addEventListener("focus", handleSearchInput);
}

if (el.stockSupplierSearchInput) {
  el.stockSupplierSearchInput.addEventListener("input", handleStockSupplierSearch);
  el.stockSupplierSearchInput.addEventListener("focus", handleStockSupplierSearch);
}

if (el.stockForm) {
  el.stockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#itemName").value.trim();
    const supplierId = el.hiddenStockSupplierId.value;
    const unit = formatUnit(document.querySelector("#itemUnit").value);

    if (!supplierId || el.stockSupplierSearchInput.value.trim() === "") {
      alert("Please select a valid supplier party from the autocomplete search suggestions menu list popup first.");
      return;
    }

    // stockForm is now add-only; editing goes through the edit stock modal

    // Duplicate check — same name (case-insensitive) already exists
    const duplicate = state.stocks.find(
      s => s.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      showConfirm(
        "Item Already Exists",
        `"${name}" is already in your stock list.\n\nIf you want to update its details, use the ✏️ edit button on that item instead.`,
        "OK",
        false
      );
      return;
    }

    const newStock = { id: generateUUID(), name, supplierId, unit };
    state.stocks.push(newStock);
    syncToSupabase("stocks", "upsert", { rows: [stockToDb(newStock)] });
    saveState();
    el.stockForm.reset();
    if (el.hiddenStockSupplierId) el.hiddenStockSupplierId.value = "";
    document.querySelector("#itemUnit").value = "";
    render();
  });
}

if (el.supplierForm) {
  el.supplierForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#supplierName").value.trim();
    const email = document.querySelector("#supplierEmail").value.trim();
    const phone = document.querySelector("#supplierPhone").value.trim().replace(/[^0-9+]/g, "");

    // supplierForm is now add-only; editing goes through the edit supplier modal

    // Duplicate check — same name (case-insensitive) already exists
    const duplicate = state.suppliers.find(
      s => s.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      alert(`"${name}" already exists in your supplier list. If you want to update their details, use the ✏️ edit button on that supplier instead.`);
      return;
    }

    const newSupplier = { id: generateUUID(), name, email, phone };
    state.suppliers.push(newSupplier);
    syncToSupabase("suppliers", "upsert", { rows: [supplierToDb(newSupplier)] });
    saveState();
    el.supplierForm.reset();
    render();
  });
}

if (el.orderForm) {
  el.orderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selectedItemId = el.hiddenOrderItemId.value;
    const item = state.stocks.find((stock) => stock.id === selectedItemId);
    
    if (!item || el.orderItemSearchInput.value !== item.name) {
      alert("Please select a valid item from the search suggestion menu popup.");
      return;
    }

    const qty = el.orderQty.value;
    addOrUpdateOrderLine(item, qty);
    saveState();

    el.orderForm.reset();
    clearInlineUnitLabel(); 
    
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = "";
    if (el.orderQty) el.orderQty.value = 1;

    if (el.recentOrderAlert) {
      el.recentOrderAlert.innerHTML = `
        <div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">
          ✔ Added: ${escapeHtml(item.name)} (Qty: ${qty})
        </div>
      `;
      el.recentOrderAlert.style.display = "block";
    }
    render();
  });
}

if (el.stockTable) {
  el.stockTable.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === "edit-stock") {
      const item = state.stocks.find((stock) => stock.id === id);
      if (item) openEditStockModal(item);
      return;
    }
  });
}

if (el.stockBulkDeleteCancelBtn) {
  el.stockBulkDeleteCancelBtn.addEventListener("click", () => {
    hideStockBulkDeleteBar();
  });
}

if (el.stockBulkDeleteExecuteBtn) {
  el.stockBulkDeleteExecuteBtn.addEventListener("click", async () => {
    const checked = el.stockTable.querySelectorAll(".stock-delete-checkbox:checked");
    if (!checked.length) return;

    const ids = Array.from(checked).map(cb => cb.dataset.itemId);

    // Check if any selected item appears in any order (active or completed)
    const blockedItems = ids.filter(id =>
      state.order.some(line => line.itemId === id)
    );

    if (blockedItems.length) {
      await showConfirm(
        "Cannot Delete",
        `${blockedItems.length} selected item${blockedItems.length === 1 ? "" : "s"} ${blockedItems.length === 1 ? "is" : "are"} present in your Active or Completed orders.\n\nRemove ${blockedItems.length === 1 ? "it" : "them"} from your orders first, then try deleting again.`,
        "OK",
        false
      );
      return;
    }

    if (!await showConfirm(
      "Delete Stock Items",
      `Permanently delete ${ids.length} selected stock item${ids.length === 1 ? "" : "s"}? This cannot be undone.`
    )) return;

    state.stocks = state.stocks.filter(s => !ids.includes(s.id));
    saveState();
    ids.forEach(id => {
      syncToSupabase("stocks", "delete", { ids: [id] });
    });
    hideStockBulkDeleteBar();
    render();
  });
}

if (el.deepWhatsAppBtn) {
  el.deepWhatsAppBtn.addEventListener("click", () => {
    if (!focusedSupplierId) return;
    const supplier = state.suppliers.find(s => s.id === focusedSupplierId);
    if (!supplier) return;

    const itemsText = buildCleanTextPayload(focusedSupplierId);
    const textMessage = `Hello ${supplier.name},\n\nPlease arrange delivery for the following purchase items:\n\n${itemsText}\n\nThank you.`;
    const cleanPhone = (supplier.phone || "").replace(/[^0-9]/g, "");

    window.open(`https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(textMessage)}`, "_blank");
    toggleActiveCompletedState(focusedSupplierId, "completed");
  });
}

if (el.deepEmailBtn) {
  el.deepEmailBtn.addEventListener("click", () => {
    if (!focusedSupplierId) return;
    const supplier = state.suppliers.find(s => s.id === focusedSupplierId);
    if (!supplier) return;

    const itemsText = buildCleanTextPayload(focusedSupplierId);
    const emailBody = `Hello ${supplier.name},\n\nPlease process the following order for our shop:\n\n${itemsText}\n\nThank you.`;

    window.location.href = `mailto:${encodeURIComponent(supplier.email || "")}?subject=${encodeURIComponent("Shop Purchase Order Request")}&body=${encodeURIComponent(emailBody)}`;
    toggleActiveCompletedState(focusedSupplierId, "completed");
  });
}

if (el.stockSearch) {
  el.stockSearch.addEventListener("input", () => {
    renderStockTable();
    handleStockSearchInput();
    if (!el.stockSearch.value.trim()) clearQuickOrderBar();
  });
  el.stockSearch.addEventListener("focus", handleStockSearchInput);
}
if (el.supplierFilter) {
  const showSupplierFilterSuggestions = () => {
    if (!el.supplierFilterSuggestionsBox) return;
    const query = el.supplierFilter.value.trim().toLowerCase();

    const matches = (query
      ? state.suppliers.filter(s => s.name.toLowerCase().includes(query))
      : [...state.suppliers]
    ).sort((a, b) => a.name.localeCompare(b.name));

    if (!matches.length) {
      el.supplierFilterSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted);cursor:default;">No suppliers match</div>`;
    } else {
      const allOption = `<div class="suggestion-item" data-name="" style="color:var(--muted);">Show all suppliers</div>`;
      el.supplierFilterSuggestionsBox.innerHTML = allOption + matches.map(s =>
        `<div class="suggestion-item" data-name="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong></div>`
      ).join("");
    }
    el.supplierFilterSuggestionsBox.style.display = "block";
  };

  el.supplierFilter.addEventListener("input", () => {
    showSupplierFilterSuggestions();
    renderStockTable();
  });
  el.supplierFilter.addEventListener("focus", showSupplierFilterSuggestions);
}

if (el.supplierFilterSuggestionsBox) {
  el.supplierFilterSuggestionsBox.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".suggestion-item");
    if (!item) return;
    event.preventDefault();
    el.supplierFilter.value = item.dataset.name || "";
    el.supplierFilterSuggestionsBox.style.display = "none";
    renderStockTable();
  });
}

if (el.stockSearchSuggestionsBox) {
  el.stockSearchSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;

    event.preventDefault();

    // Fill the search box with the selected item name and filter the table
    if (el.stockSearch) el.stockSearch.value = suggestionItem.dataset.name || "";
    el.stockSearchSuggestionsBox.style.display = "none";
    renderStockTable();
  });
}

if (el.stockQuickOrderAddBtn) {
  el.stockQuickOrderAddBtn.addEventListener("click", () => {
    if (!selectedQuickOrderItem) return;
    const qty = Math.max(1, Number(el.stockQuickOrderQty?.value) || 1);
    const addedItem = selectedQuickOrderItem;

    addOrUpdateOrderLine(addedItem, qty);
    saveState();

    if (el.stockQuickOrderAlert) {
      el.stockQuickOrderAlert.innerHTML = `
        <div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">
          ✔ Added: ${escapeHtml(addedItem.name)} (Qty: ${qty})
        </div>
      `;
      el.stockQuickOrderAlert.style.display = "block";
      setTimeout(() => {
        if (el.stockQuickOrderAlert) el.stockQuickOrderAlert.style.display = "none";
      }, 3000);
    }

    clearQuickOrderBar();
    if (el.stockSearch) el.stockSearch.value = "";
    renderStockTable();
  });
}

if (el.stockQuickOrderCancelBtn) {
  el.stockQuickOrderCancelBtn.addEventListener("click", () => {
    clearQuickOrderBar();
    if (el.stockSearch) el.stockSearch.value = "";
    renderStockTable();
  });
}

if (el.stockQuickOrderQty) {
  el.stockQuickOrderQty.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (el.stockQuickOrderAddBtn) el.stockQuickOrderAddBtn.click();
    }
  });
}

if (el.supplierSearchInput) {
  el.supplierSearchInput.addEventListener("input", () => {
    renderSupplierList();
    handleSupplierListSearch();
  });
  el.supplierSearchInput.addEventListener("focus", handleSupplierListSearch);
}

if (el.supplierSearchSuggestionsBox) {
  el.supplierSearchSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;

    event.preventDefault();

    if (el.supplierSearchInput) el.supplierSearchInput.value = suggestionItem.dataset.name;
    el.supplierSearchSuggestionsBox.style.display = "none";
    renderSupplierList();
  });
}

el.tabButtons.forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.pageTarget));
});

// ---------- Import / Export ----------

const CSV_HEADERS = ["Item Name", "Supplier", "Unit", "Supplier Email", "Supplier Phone"];

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function buildStockExportRows() {
  return state.stocks.map((item) => {
    const supplier = state.suppliers.find((s) => s.id === item.supplierId);
    return {
      name: item.name,
      supplier: supplier?.name || "",
      unit: item.unit || "",
      email: supplier?.email || "",
      phone: supplier?.phone || ""
    };
  });
}

function toCsvValue(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvText() {
  const rows = buildStockExportRows();
  const lines = [CSV_HEADERS.map(toCsvValue).join(",")];
  rows.forEach((row) => {
    lines.push([row.name, row.supplier, row.unit, row.email, row.phone].map(toCsvValue).join(","));
  });
  return lines.join("\r\n");
}

function buildExcelHtml() {
  const rows = buildStockExportRows();
  const headerCells = CSV_HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.supplier)}</td>
          <td>${escapeHtml(row.unit)}</td>
          <td>${escapeHtml(row.email)}</td>
          <td>${escapeHtml(row.phone)}</td>
        </tr>`
    )
    .join("");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Stock</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body>
<table border="1">
<thead><tr>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
</body>
</html>`;
}

if (el.exportCsvBtn) {
  el.exportCsvBtn.addEventListener("click", () => {
    if (!state.stocks.length) {
      alert("There are no stock items to export yet.");
      return;
    }
    downloadBlob(buildCsvText(), "shop-stock-list.csv", "text/csv;charset=utf-8;");
  });
}

if (el.exportExcelBtn) {
  el.exportExcelBtn.addEventListener("click", () => {
    if (!state.stocks.length) {
      alert("There are no stock items to export yet.");
      return;
    }
    downloadBlob(buildExcelHtml(), "shop-stock-list.xls", "application/vnd.ms-excel");
  });
}

if (el.exportDataBtn) {
  el.exportDataBtn.addEventListener("click", () => {
    downloadBlob(JSON.stringify(state, null, 2), "shop-stock-data.json", "application/json");
  });
}

function findOrCreateSupplierByName(name, email, phone, newlyCreated) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return "";

  let supplier = state.suppliers.find(
    (s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase()
  );

  if (!supplier) {
    supplier = { id: generateUUID(), name: trimmedName, email: email || "", phone: phone || "" };
    state.suppliers.push(supplier);
    if (newlyCreated) newlyCreated.push(supplier);
  }

  return supplier.id;
}

async function applyImportedStockRows(rows) {
  const newlyCreatedSuppliers = [];
  const affectedStocks = [];

  rows
    .filter((row) => row.name && row.name.trim())
    .forEach((row) => {
      const trimmedName = row.name.trim();
      const supplierId = findOrCreateSupplierByName(row.supplier, row.email, row.phone, newlyCreatedSuppliers);
      const unit = formatUnit(row.unit);

      // Match an existing item by name (case-insensitive) so re-importing the
      // same file updates it instead of creating a duplicate. Anything not
      // matched is a brand new item — nothing existing gets removed.
      const existing = state.stocks.find(
        (item) => item.name.trim().toLowerCase() === trimmedName.toLowerCase()
      );

      if (existing) {
        if (supplierId) existing.supplierId = supplierId;
        if (unit) existing.unit = unit;
        affectedStocks.push(existing);
      } else {
        const newItem = { id: generateUUID(), name: trimmedName, supplierId, unit };
        state.stocks.push(newItem);
        affectedStocks.push(newItem);
      }
    });

  saveState();

  if (newlyCreatedSuppliers.length) {
    await syncToSupabase("suppliers", "upsert", { rows: newlyCreatedSuppliers.map(supplierToDb) });
  }
  if (affectedStocks.length) {
    await syncToSupabase("stocks", "upsert", { rows: affectedStocks.map(stockToDb) });
  }

  render();
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function mapHeaderIndexes(headerRow) {
  const indexes = {};
  headerRow.forEach((header, idx) => {
    const key = String(header).trim().toLowerCase();
    if (key === "item name") indexes.name = idx;
    else if (key === "supplier") indexes.supplier = idx;
    else if (key === "unit") indexes.unit = idx;
    else if (key === "supplier email") indexes.email = idx;
    else if (key === "supplier phone") indexes.phone = idx;
  });
  return indexes;
}

function rowsFromTable(tableRows, headerIndexes) {
  return tableRows.map((cells) => ({
    name: cells[headerIndexes.name] ?? "",
    supplier: headerIndexes.supplier !== undefined ? cells[headerIndexes.supplier] ?? "" : "",
    unit: headerIndexes.unit !== undefined ? cells[headerIndexes.unit] ?? "" : "",
    email: headerIndexes.email !== undefined ? cells[headerIndexes.email] ?? "" : "",
    phone: headerIndexes.phone !== undefined ? cells[headerIndexes.phone] ?? "" : ""
  }));
}

function importFromCsvText(text) {
  const allRows = parseCsvText(text);
  if (!allRows.length) {
    alert("That CSV file appears to be empty.");
    return false;
  }
  const headerIndexes = mapHeaderIndexes(allRows[0]);
  if (headerIndexes.name === undefined) {
    alert("Could not find an 'Item Name' column in this CSV file.");
    return false;
  }
  const rows = rowsFromTable(allRows.slice(1), headerIndexes);
  applyImportedStockRows(rows);
  return true;
}

function importFromExcelHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const table = doc.querySelector("table");
  if (!table) {
    alert("Could not read a stock table from this file. Only .xls files exported from this app are supported for import.");
    return false;
  }

  const tableRows = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")].map((cell) => cell.textContent.trim())
  );

  if (!tableRows.length) {
    alert("That Excel file appears to be empty.");
    return false;
  }

  const headerIndexes = mapHeaderIndexes(tableRows[0]);
  if (headerIndexes.name === undefined) {
    alert("Could not find an 'Item Name' column in this Excel file.");
    return false;
  }

  const rows = rowsFromTable(tableRows.slice(1), headerIndexes);
  applyImportedStockRows(rows);
  return true;
}

async function fullRestoreToSupabase(suppliers, stocks, orders) {
  if (!sb) return;
  // Children-first delete, then parents-first insert, to respect foreign keys
  // across all three tables during a full backup restore.
  await syncToSupabase("orders", "replaceAll", { rows: [] });
  await syncToSupabase("stocks", "replaceAll", { rows: [] });
  await syncToSupabase("suppliers", "replaceAll", { rows: suppliers.map(supplierToDb) });
  if (stocks.length) {
    await syncToSupabase("stocks", "upsert", { rows: stocks.map(stockToDb) });
  }
  if (orders.length) {
    await syncToSupabase("orders", "upsert", { rows: orders.map(orderToDb) });
  }
}

async function importFromJsonText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    alert("That file is not valid JSON.");
    return false;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.suppliers) && !Array.isArray(parsed.stocks)) {
    alert("That JSON file doesn't look like a shop data backup.");
    return false;
  }

  state = {
    suppliers: Array.isArray(parsed.suppliers) ? parsed.suppliers : [],
    stocks: (Array.isArray(parsed.stocks) ? parsed.stocks : []).map(normalizeStockItem),
    order: Array.isArray(parsed.order) ? parsed.order : []
  };
  saveState();
  await fullRestoreToSupabase(state.suppliers, state.stocks, state.order);
  render();
  return true;
}

if (el.importDataInput) {
  el.importDataInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const reader = new FileReader();

    reader.onload = async () => {
      const text = reader.result;
      let success = false;

      if (fileName.endsWith(".json")) {
        if (await showConfirm("Import Backup", "This will replace ALL current data — suppliers, stock items, and orders. This cannot be undone.", "Import", true)) {
          success = await importFromJsonText(text);
        }
      } else if (fileName.endsWith(".xls")) {
        if (await showConfirm("Import Excel", "This will add new stock items and update existing ones that match by name. Your current orders will not be affected.", "Import", false)) {
          success = importFromExcelHtml(text);
        }
      } else {
        if (await showConfirm("Import CSV", "This will add new stock items and update existing ones that match by name. Your current orders will not be affected.", "Import", false)) {
          success = importFromCsvText(text);
        }
      }

      if (success) alert("Import complete.");
      el.importDataInput.value = "";
    };

    reader.onerror = () => {
      alert("Could not read that file. Please try again.");
      el.importDataInput.value = "";
    };

    reader.readAsText(file);
  });
}

function initializeApp() {
  renderSupplierOptions();
  renderStockTable();
  renderSupplierList();
  renderBifurcatedOrders();
}

initializeApp();

if (location.hash) {
  const pageId = location.hash.slice(1);
  if (document.getElementById(pageId)) {
    showPage(pageId);
  }
}

// Show the locally-cached data instantly (above), then sync with Supabase
// in the background — pushes any offline-queued changes first, then pulls
// the latest shared data and re-renders if anything changed.
syncOnStartup();
