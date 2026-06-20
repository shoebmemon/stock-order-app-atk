const STORAGE_KEY = "shop-stock-order-app-v15";

function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2, 11) + "-" + Date.now().toString(36);
}

const sampleState = {
  suppliers: [
    { id: generateUUID(), name: "Sunrise Traders", email: "orders@sunrisetraders.example", phone: "9876543210" },
    { id: generateUUID(), name: "City Wholesale", email: "sales@citywholesale.example", phone: "9123456780" },
    { id: generateUUID(), name: "Fresh Pack Supplies", email: "", phone: "9000011122" }
  ],
  stocks: [],
  order: []
};

sampleState.stocks = [
  { id: generateUUID(), name: "Basmati Rice 5kg", supplierId: sampleState.suppliers[0].id, unit: "bags" },
  { id: generateUUID(), name: "Toor Dal 1kg", supplierId: sampleState.suppliers[0].id, unit: "packs" },
  { id: generateUUID(), name: "Dishwash Liquid 500ml", supplierId: sampleState.suppliers[1].id, unit: "bottles" },
  { id: generateUUID(), name: "Paper Carry Bags Medium", supplierId: sampleState.suppliers[2].id, unit: "bundles" }
];

let state = loadState();
let editingSupplierId = null;
let editingStockId = null;

let currentStatusFilter = "active"; 
let focusedSupplierId = null;

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
  bulkDeleteExecuteBtn: document.querySelector("#bulkDeleteExecuteBtn"),

  masterBulkDeleteToolbar: document.querySelector("#masterBulkDeleteToolbar"),
  masterBulkDeleteCountLabel: document.querySelector("#masterBulkDeleteCountLabel"),
  masterBulkDeleteExecuteBtn: document.querySelector("#masterBulkDeleteExecuteBtn"),
  masterBulkDeleteAllBtn: document.querySelector("#masterBulkDeleteAllBtn"),

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
  supplierSearchSuggestionsBox: document.querySelector("#supplierSearchSuggestionsBox")
};

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(sampleState);

  try {
    const parsed = JSON.parse(saved);
    return {
      suppliers: parsed.suppliers || [],
      stocks: (parsed.stocks || []).map(normalizeStockItem),
      order: parsed.order || []
    };
  } catch {
    return structuredClone(sampleState);
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
  } else {
    state.order.push({
      id: generateUUID(),
      itemId: item.id,
      supplierId: item.supplierId,
      quantity,
      status: "active",
      dateCreated: getFormattedDate()
    });
  }
}

function toggleActiveCompletedState(supplierId, newStatus) {
  state.order.forEach((line) => {
    if (line.supplierId === supplierId && (line.status || "active") !== newStatus) {
      line.status = newStatus;
    }
  });
  saveState();

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
}

function renderSupplierOptions() {
  if (!el.supplierFilter) return;
  const selectedFilterSupplier = el.supplierFilter.value;
  
  el.supplierFilter.innerHTML = `<option value="all">All suppliers</option>` + state.suppliers
    .map((supplier) => `<option value="${supplier.id}">${escapeHtml(supplier.name)}</option>`)
    .join("");

  keepSelectValue(el.supplierFilter, selectedFilterSupplier || "all");
}

function renderStockTable() {
  if (!el.stockTable || !el.stockSearch || !el.supplierFilter) return;
  const query = el.stockSearch.value.trim().toLowerCase();
  const supplierFilter = el.supplierFilter.value || "all";

  const visibleStocks = state.stocks.filter((item) => {
    const matchesQuery = [item.name, supplierName(item.supplierId)].join(" ").toLowerCase().includes(query);
    return matchesQuery && (supplierFilter === "all" || item.supplierId === supplierFilter);
  });

  if (!visibleStocks.length) {
    el.stockTable.innerHTML = `<tr><td colspan="4" class="empty">No stock items found.</td></tr>`;
    return;
  }

  el.stockTable.innerHTML = visibleStocks
    .map((item) => `
      <tr>
        <td data-label="Item"><div class="item-name">${escapeHtml(item.name)}</div></td>
        <td data-label="Supplier">${escapeHtml(supplierName(item.supplierId))}</td>
        <td data-label="Unit">${escapeHtml(item.unit || "pcs")}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <button class="icon-btn mini-icon-btn" type="button" data-action="quick-order" data-id="${item.id}" title="Add to order">➕</button>
            <button class="icon-btn mini-icon-btn" type="button" data-action="edit-stock" data-id="${item.id}" title="Edit item">✏️</button>
            <button class="icon-btn mini-icon-btn danger-soft" type="button" data-action="delete-stock" data-id="${item.id}" title="Delete item">❌</button>
          </div>
        </td>
      </tr>
    `).join("");
}

function renderSupplierList() {
  if (!el.supplierList) return;
  if (!state.suppliers.length) {
    el.supplierList.innerHTML = `<div class="empty">Add your first supplier above.</div>`;
    return;
  }

  const query = (el.supplierSearchInput?.value || "").trim().toLowerCase();
  const visibleSuppliers = query
    ? state.suppliers.filter((supplier) => supplier.name.toLowerCase().includes(query))
    : state.suppliers;

  if (!visibleSuppliers.length) {
    el.supplierList.innerHTML = `<div class="empty">No suppliers match your search.</div>`;
    return;
  }

  el.supplierList.innerHTML = visibleSuppliers
    .map((supplier) => `
      <div class="supplier-card" style="border: 1px solid var(--line); padding: 12px; margin-bottom: 8px; border-radius: 6px; background:#fff;">
        <div>
          <strong style="font-size: 1.05rem; display: block; margin-bottom: 4px;">${escapeHtml(supplier.name)}</strong>
          <div class="supplier-meta" style="font-size:0.85rem; color:var(--muted); line-height: 1.4;">
            <div>Email: ${escapeHtml(supplier.email || "None")}</div>
            <div>Phone: ${escapeHtml(supplier.phone || "None")}</div>
          </div>
          <div class="row-actions" style="margin-top: 10px; display: flex; gap: 8px;">
            <button class="icon-btn" type="button" data-action="edit-supplier" data-id="${supplier.id}" style="padding: 4px 10px; min-height: auto; font-size: 0.8rem;">Edit</button>
            <button class="icon-btn danger-soft" type="button" data-action="delete-supplier" data-id="${supplier.id}" style="padding: 4px 10px; min-height: auto; font-size: 0.8rem;">Delete</button>
          </div>
        </div>
      </div>
    `).join("");
}

function handleSearchInput() {
  if (!el.orderItemSearchInput || !el.searchSuggestionsBox) return;
  const query = el.orderItemSearchInput.value.trim().toLowerCase();
  if (!query) {
    el.searchSuggestionsBox.style.display = "none";
    return;
  }

  const matches = state.stocks.filter((item) => 
    item.name.toLowerCase().includes(query) || supplierName(item.supplierId).toLowerCase().includes(query)
  );

  if (!matches.length) {
    el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No items match your search.</div>`;
    el.searchSuggestionsBox.style.display = "block";
    return;
  }

  el.searchSuggestionsBox.innerHTML = matches
    .map((item) => `
      <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="vendor-tag">Supplier: ${escapeHtml(supplierName(item.supplierId))}</span>
      </div>
    `).join("");
  el.searchSuggestionsBox.style.display = "block";
}

function handleStockSupplierSearch() {
  if (!el.stockSupplierSearchInput || !el.supplierSuggestionsBox) return;
  const query = el.stockSupplierSearchInput.value.trim().toLowerCase();
  if (!query) {
    el.supplierSuggestionsBox.style.display = "none";
    return;
  }

  const matches = state.suppliers.filter((supplier) => 
    supplier.name.toLowerCase().includes(query)
  );

  if (!matches.length) {
    el.supplierSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers match your search.</div>`;
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
  if (!query) {
    el.supplierSearchSuggestionsBox.style.display = "none";
    return;
  }

  const matches = state.suppliers.filter((supplier) =>
    supplier.name.toLowerCase().includes(query)
  );

  if (!matches.length) {
    el.supplierSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No suppliers match your search.</div>`;
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
  if (!query) {
    el.stockSearchSuggestionsBox.style.display = "none";
    return;
  }

  const matches = state.stocks.filter((item) =>
    item.name.toLowerCase().includes(query) || supplierName(item.supplierId).toLowerCase().includes(query)
  );

  if (!matches.length) {
    el.stockSearchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No items match your search.</div>`;
    el.stockSearchSuggestionsBox.style.display = "block";
    return;
  }

  el.stockSearchSuggestionsBox.innerHTML = matches
    .map((item) => `
      <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="vendor-tag">Supplier: ${escapeHtml(supplierName(item.supplierId))}</span>
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

  const uniqueSuppliers = [...new Set(targetLines.map(line => line.supplierId))];

  el.bifurcatedOrderContainer.innerHTML = uniqueSuppliers
    .map((sId) => {
      const vendorLabel = supplierName(sId);
      const sLinesCount = targetLines.filter(line => line.supplierId === sId).length;

      return `
        <div class="single-line-row" data-supplier-id="${sId}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0;">
          <div class="vendor-title-wrapper">
            ${currentStatusFilter === 'completed' ? `<input type="checkbox" class="master-multi-delete-checkbox" data-supplier-id="${sId}">` : ''}
            <span class="vendor-title">${escapeHtml(vendorLabel)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0;">
            <span class="badge-count">${sLinesCount} Item${sLinesCount === 1 ? '' : 's'}</span>
          </div>
        </div>
      `;
    }).join("");

  if (currentStatusFilter === 'completed') {
    bindMasterCheckboxListeners();
    setupMasterLongPressTriggers(); 
  }
}

function setupMasterLongPressTriggers() {
  const rows = el.bifurcatedOrderContainer.querySelectorAll(".single-line-row");
  rows.forEach(row => {
    row.addEventListener("mousedown", (e) => startMasterLongPress(e, row));
    row.addEventListener("mouseup", cancelMasterLongPress);
    row.addEventListener("mouseleave", cancelMasterLongPress);
    
    row.addEventListener("touchstart", (e) => startMasterLongPress(e, row), { passive: true });
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
    openSupplierDeepView(targetRow.dataset.supplierId);
  });
}

function setupDeepViewLongPressTriggers() {
  const cards = el.deepViewLinesList.querySelectorAll(".order-card");
  cards.forEach(card => {
    card.addEventListener("mousedown", (e) => startDeepLongPress(e, card));
    card.addEventListener("mouseup", cancelDeepLongPress);
    card.addEventListener("mouseleave", cancelDeepLongPress);
    
    card.addEventListener("touchstart", (e) => startDeepLongPress(e, card), { passive: true });
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
    el.masterBulkDeleteCountLabel.textContent = `${count} supplier${count === 1 ? "" : "s"} selected`;
    el.masterBulkDeleteToolbar.style.display = "flex";
  } else {
    el.masterBulkDeleteToolbar.style.display = "none";
    if (el.masterView) el.masterView.classList.remove("selection-active"); 
  }
}

function openSupplierDeepView(supplierId) {
  focusedSupplierId = supplierId;
  const supplier = state.suppliers.find(s => s.id === supplierId);
  const filteredLines = state.order.filter(line => line.supplierId === supplierId && (line.status || "active") === currentStatusFilter);

  if (!filteredLines.length) {
    if (el.deepView) el.deepView.style.display = "none";
    if (el.masterView) el.masterView.style.display = "block";
    renderBifurcatedOrders();
    return;
  }

  if (el.deepViewVendorTitle) el.deepViewVendorTitle.textContent = supplier ? supplier.name : "Supplier";
  
  const dateStr = filteredLines[0].dateCreated || getFormattedDate();
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
              <button class="icon-btn danger-soft" type="button" data-action="remove-deep-line" data-line-id="${line.id}" style="min-width: 32px; min-height: 32px; height: 32px; width: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 6px; border: 1px solid rgba(255,59,48,0.15); background:#fff5f5;">
                <span class="custom-red-trash-icon"></span>
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

document.addEventListener("click", (event) => {
  if (isLongPressTriggered) {
    isLongPressTriggered = false;
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;

  if (action === "remove-line") {
    if (confirm("Delete this profile item permanently?")) {
      state.order = state.order.filter((line) => line.id !== id);
      saveState();
      render();
    }
  }

  if (action === "remove-deep-line") {
    const lineId = button.dataset.lineId;
    if (confirm("Remove this item from the active purchase order list?")) {
      state.order = state.order.filter(line => line.id !== lineId);
      saveState();
      openSupplierDeepView(focusedSupplierId); 
    }
  }

  if (action === "edit-supplier") {
    const supplier = state.suppliers.find((s) => s.id === id);
    if (supplier) {
      editingSupplierId = supplier.id;
      document.querySelector("#supplierName").value = supplier.name;
      document.querySelector("#supplierEmail").value = supplier.email || "";
      document.querySelector("#supplierPhone").value = supplier.phone || "";
      document.querySelector("#supplierForm button[type='submit']").textContent = "Update Supplier";
      if (document.querySelector("#supplierForm")) document.querySelector("#supplierForm").scrollIntoView({ behavior: 'smooth' });
    }
  }

  if (action === "delete-supplier") {
    if (confirm("Delete this supplier? This will also remove all their associated stock catalog listings and order entries.")) {
      state.suppliers = state.suppliers.filter((s) => s.id !== id);
      state.stocks = state.stocks.filter((item) => item.supplierId !== id);
      state.order = state.order.filter((line) => line.supplierId !== id);
      saveState();
      render();
    }
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
  el.toggleStatusStateBtn.addEventListener("click", () => {
    if (!focusedSupplierId) return;
    if (currentStatusFilter === "active") {
      if (confirm("Move this entire purchase list to completed orders?")) {
        toggleActiveCompletedState(focusedSupplierId, "completed");
      }
    } else {
      if (confirm("Move this entire purchase list back to active order lists?")) {
        toggleActiveCompletedState(focusedSupplierId, "active");
      }
    }
  });
}

if (el.bulkDeleteExecuteBtn) {
  el.bulkDeleteExecuteBtn.addEventListener("click", () => {
    const selectedBoxes = el.deepViewLinesList.querySelectorAll(".multi-delete-checkbox:checked");
    if (!selectedBoxes.length) return;

    if (confirm(`Are you sure you want to delete these ${selectedBoxes.length} selected items from your order?`)) {
      const idsToDelete = Array.from(selectedBoxes).map(box => box.dataset.lineId);
      state.order = state.order.filter(line => !idsToDelete.includes(line.id));
      saveState();
      openSupplierDeepView(focusedSupplierId);
    }
  });
}

if (el.masterBulkDeleteExecuteBtn) {
  el.masterBulkDeleteExecuteBtn.addEventListener("click", () => {
    const selectedBoxes = el.bifurcatedOrderContainer.querySelectorAll(".master-multi-delete-checkbox:checked");
    if (!selectedBoxes.length) return;

    if (confirm(`Are you sure you want to permanently delete the entire completed order history for these ${selectedBoxes.length} selected suppliers?`)) {
      const supplierIdsToDelete = Array.from(selectedBoxes).map(box => box.dataset.supplierId);
      state.order = state.order.filter(line => !(supplierIdsToDelete.includes(line.supplierId) && line.status === "completed"));
      saveState();
      renderBifurcatedOrders();
    }
  });
}

if (el.masterBulkDeleteAllBtn) {
  el.masterBulkDeleteAllBtn.addEventListener("click", () => {
    if (confirm("⚠️ CRITICAL ACTION: Are you sure you want to permanently wipe out ALL completed order histories from your dashboard storage? This cannot be undone.")) {
      state.order = state.order.filter(line => (line.status || "active") !== "completed");
      saveState();
      renderBifurcatedOrders();
    }
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

    if (el.orderItemSearchInput) el.orderItemSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = suggestionItem.dataset.id;
    
    const selectedItem = state.stocks.find(s => s.id === suggestionItem.dataset.id);
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
    if (document.querySelector("#itemUnit")) {
      document.querySelector("#itemUnit").focus();
    }
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
});

if (el.orderItemSearchInput) {
  el.orderItemSearchInput.addEventListener("input", () => {
    handleSearchInput();
    if (!el.orderItemSearchInput.value.trim()) {
      clearInlineUnitLabel();
    }
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

    if (editingStockId) {
      const stockItem = state.stocks.find((item) => item.id === editingStockId);
      if (stockItem) {
        stockItem.name = name;
        stockItem.supplierId = supplierId;
        stockItem.unit = unit;
      }
      editingStockId = null;
      if (el.stockSubmitBtn) el.stockSubmitBtn.textContent = "Save Stock Item";
    } else {
      state.stocks.push({ id: generateUUID(), name, supplierId, unit });
    }
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

    if (editingSupplierId) {
      const supplier = state.suppliers.find((s) => s.id === editingSupplierId);
      if (supplier) {
        supplier.name = name;
        supplier.email = email;
        supplier.phone = phone;
      }
      editingSupplierId = null;
      document.querySelector("#supplierForm button[type='submit']").textContent = "Add Supplier";
    } else {
      state.suppliers.push({ id: generateUUID(), name, email, phone });
    }
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

    if (action === "delete-stock") {
      if (confirm("Are you sure you want to permanently delete this stock item? This will remove it from active logs.")) {
        state.stocks = state.stocks.filter((item) => item.id !== id);
        state.order = state.order.filter((line) => line.itemId !== id);
        saveState();
        render();
      }
      return;
    }

    if (action === "edit-stock") {
      const item = state.stocks.find((stock) => stock.id === id);
      if (item) {
        editingStockId = item.id;
        document.querySelector("#itemName").value = item.name;
        if (el.stockSupplierSearchInput) el.stockSupplierSearchInput.value = supplierName(item.supplierId);
        if (el.hiddenStockSupplierId) el.hiddenStockSupplierId.value = item.supplierId;
        document.querySelector("#itemUnit").value = item.unit || "";
        if (el.stockSubmitBtn) el.stockSubmitBtn.textContent = "Update Stock Item";
        if (el.stockForm) el.stockForm.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }

    if (action === "quick-order") {
      const item = state.stocks.find((stock) => stock.id === id);
      if (!item) return;
      addOrUpdateOrderLine(item, 1);
      if (el.orderItemSearchInput) el.orderItemSearchInput.value = item.name;
      if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = id;
      
      if (el.orderQtyInlineUnit) el.orderQtyInlineUnit.textContent = item.unit || "pcs";

      if (el.recentOrderAlert) {
        el.recentOrderAlert.innerHTML = `
          <div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">
            ✔ Added: ${escapeHtml(item.name)} (Qty: 1)
          </div>
        `;
        el.recentOrderAlert.style.display = "block";
      }
      showPage("orderPage");
    }
    saveState();
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
if (el.supplierFilter) el.supplierFilter.addEventListener("change", renderStockTable);

if (el.stockSearchSuggestionsBox) {
  el.stockSearchSuggestionsBox.addEventListener("mousedown", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;

    event.preventDefault();

    const item = state.stocks.find((s) => s.id === suggestionItem.dataset.id);
    if (!item) return;

    selectQuickOrderItem(item);
    el.stockSearchSuggestionsBox.style.display = "none";
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

function findOrCreateSupplierByName(name, email, phone) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return "";

  let supplier = state.suppliers.find(
    (s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase()
  );

  if (!supplier) {
    supplier = { id: generateUUID(), name: trimmedName, email: email || "", phone: phone || "" };
    state.suppliers.push(supplier);
  }

  return supplier.id;
}

function applyImportedStockRows(rows) {
  const newStocks = rows
    .filter((row) => row.name && row.name.trim())
    .map((row) => ({
      id: generateUUID(),
      name: row.name.trim(),
      supplierId: findOrCreateSupplierByName(row.supplier, row.email, row.phone),
      unit: formatUnit(row.unit)
    }));

  state.stocks = newStocks;
  state.order = [];
  saveState();
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

function importFromJsonText(text) {
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
  render();
  return true;
}

if (el.importDataInput) {
  el.importDataInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const reader = new FileReader();

    reader.onload = () => {
      const text = reader.result;
      let success = false;

      if (fileName.endsWith(".json")) {
        if (confirm("Importing this backup will replace ALL current data (suppliers, stock items, and orders). Continue?")) {
          success = importFromJsonText(text);
        }
      } else if (fileName.endsWith(".xls")) {
        if (confirm("Importing this Excel file will replace your current stock list and clear the current order list. Continue?")) {
          success = importFromExcelHtml(text);
        }
      } else {
        if (confirm("Importing this CSV file will replace your current stock list and clear the current order list. Continue?")) {
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