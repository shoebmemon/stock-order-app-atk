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

const el = {
  stockForm: document.querySelector("#stockForm"),
  supplierForm: document.querySelector("#supplierForm"),
  orderForm: document.querySelector("#orderForm"),
  stockTable: document.querySelector("#stockTable"),
  supplierList: document.querySelector("#supplierList"),
  bifurcatedOrderContainer: document.querySelector("#bifurcatedOrderContainer"),
  itemSupplier: document.querySelector("#itemSupplier"),
  orderItemSearchInput: document.querySelector("#orderItemSearchInput"),
  hiddenOrderItemId: document.querySelector("#hiddenOrderItemId"),
  searchSuggestionsBox: document.querySelector("#searchSuggestionsBox"),
  orderQty: document.querySelector("#orderQty"),
  supplierFilter: document.querySelector("#supplierFilter"),
  stockSearch: document.querySelector("#stockSearch"),
  recentOrderAlert: document.querySelector("#recentOrderAlert"),
  stockSubmitBtn: document.querySelector("#stockSubmitBtn"),
  
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
  subPageViews: document.querySelectorAll(".sub-page-view")
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

// Clear units tracking strings cleanly inside active form buffers
function formatUnit(value) {
  return String(value || "pcs").trim() || "pcs";
}

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
  if (!el.itemSupplier || !el.supplierFilter) return;
  const selectedItemSupplier = el.itemSupplier.value;
  const selectedFilterSupplier = el.supplierFilter.value;
  const supplierOptions = state.suppliers
    .map((supplier) => `<option value="${supplier.id}">${escapeHtml(supplier.name)}</option>`)
    .join("");

  el.itemSupplier.innerHTML = supplierOptions;
  el.supplierFilter.innerHTML = `<option value="all">All suppliers</option>${supplierOptions}`;

  keepSelectValue(el.itemSupplier, selectedItemSupplier);
  keepSelectValue(el.supplierFilter, selectedFilterSupplier || "all");

  if (!state.suppliers.length) {
    el.itemSupplier.innerHTML = `<option value="">Add supplier first</option>`;
  }
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
        <td data-label="Unit">${escapeHtml(formatUnit(item.unit))}</td>
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

  el.supplierList.innerHTML = state.suppliers
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
        <div class="single-line-row" data-supplier-id="${sId}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">
            ${currentStatusFilter === 'completed' ? `<input type="checkbox" class="master-multi-delete-checkbox" data-supplier-id="${sId}">` : ''}
            <span class="vendor-title">${escapeHtml(vendorLabel)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
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
            
            <div style="min-width: 0; flex: 1; margin-left: 2px;">
              <strong>${escapeHtml(item?.name || "Deleted item")}</strong>
              <div class="order-meta" style="font-size: 0.85rem; color: var(--muted); margin-top: 2px;">Qty: ${formatNumber(line.quantity)} ${escapeHtml(item?.unit || "")}</div>
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

function toggleActiveCompletedState(supplierId, targetTargetStatus) {
  state.order.forEach((line) => {
    if (line.supplierId === supplierId && (line.status || "active") === currentStatusFilter) {
      line.status = targetTargetStatus;
    }
  });
  saveState();
  if (el.deepView) el.deepView.style.display = "none";
  if (el.masterView) el.masterView.style.display = "block";
  renderBifurcatedOrders();
}

function addOrUpdateOrderLine(item, quantity) {
  const existing = state.order.find((line) => line.itemId === item.id && (line.status || "active") === "active");
  if (existing) {
    existing.quantity = Number(existing.quantity) + Number(quantity);
  } else {
    state.order.push({
      id: generateUUID(),
      supplierId: item.supplierId,
      itemId: item.id,
      quantity: Number(quantity),
      dateCreated: getFormattedDate(),
      status: "active"
    });
  }
}

function clearInlineUnitLabel() {
  if (el.orderQtyInlineUnit) {
    el.orderQtyInlineUnit.textContent = "";
  }
}

function buildCleanTextPayload(supplierId) {
  const lines = state.order.filter((line) => line.supplierId === supplierId && (line.status || "active") === currentStatusFilter);
  return lines.map((line, idx) => {
    const item = state.stocks.find((s) => s.id === line.itemId);
    return `${idx + 1}. ${item?.name || "Item"} - ${line.quantity} ${item?.unit || ""}`;
  }).join("\n");
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// FIXED: Clean global status filters listener loop that doesn't trigger on list long presses
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

if (el.bifurcatedOrderContainer) {
  el.bifurcatedOrderContainer.addEventListener("click", (event) => {
    // FIXED: Blocks selection active flag mutations when switching filter tabs layout view modes
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
  el.searchSuggestionsBox.addEventListener("click", (event) => {
    const suggestionItem = event.target.closest(".suggestion-item");
    if (!suggestionItem || !suggestionItem.dataset.id) return;
    
    if (el.orderItemSearchInput) el.orderItemSearchInput.value = suggestionItem.dataset.name;
    if (el.hiddenOrderItemId) el.hiddenOrderItemId.value = suggestionItem.dataset.id;
    
    const selectedItem = state.stocks.find(s => s.id === suggestionItem.dataset.id);
    if (selectedItem && el.orderQtyInlineUnit) {
      el.orderQtyInlineUnit.textContent = formatUnit(selectedItem.unit);
    }

    el.searchSuggestionsBox.style.display = "none";
    if (el.orderQty) {
      el.orderQty.focus();
      el.orderQty.select();
    }
  });
}

document.addEventListener("click", (event) => {
  if (el.searchSuggestionsBox && !event.target.closest(".search-suggest-container")) {
    el.searchSuggestionsBox.style.display = "none";
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

if (el.stockForm) {
  el.stockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#itemName").value.trim();
    const supplierId = el.itemSupplier.value;
    const unit = formatUnit(document.querySelector("#itemUnit").value);

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
    document.querySelector("#itemUnit").value = "pcs";
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
        if (el.itemSupplier) el.itemSupplier.value = item.supplierId;
        document.querySelector("#itemUnit").value = item.unit || "pcs";
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
      
      if (el.orderQtyInlineUnit) el.orderQtyInlineUnit.textContent = formatUnit(item.unit);

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

if (el.stockSearch) el.stockSearch.addEventListener("input", renderStockTable);
if (el.supplierFilter) el.supplierFilter.addEventListener("change", renderStockTable);

el.tabButtons.forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.pageTarget));
});

if (document.querySelector("#exportDataBtn")) {
  document.querySelector("#exportDataBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "shop-stock-data.json";
    link.click();
  });
}

function initializeApp() {
  renderSupplierOptions();
  if (state.suppliers.length > 0 && el.itemSupplier && !el.itemSupplier.value) {
    el.itemSupplier.value = state.suppliers[0].id;
  }
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
