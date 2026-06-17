const STORAGE_KEY = "shop-stock-order-app-v10";

// Mobile safe unique ID fallback handler
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
  { id: generateUUID(), name: "Basmati Rice 5kg", category: "Grocery", supplierId: sampleState.suppliers[0].id, unit: "bags" },
  { id: generateUUID(), name: "Toor Dal 1kg", category: "Grocery", supplierId: sampleState.suppliers[0].id, unit: "packs" },
  { id: generateUUID(), name: "Dishwash Liquid 500ml", category: "Cleaning", supplierId: sampleState.suppliers[1].id, unit: "bottles" },
  { id: generateUUID(), name: "Paper Carry Bags Medium", category: "Packing", supplierId: sampleState.suppliers[2].id, unit: "bundles" }
];

let state = loadState();

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
  supplierFilter: document.querySelector("#supplierFilter"),
  stockSearch: document.querySelector("#stockSearch"),
  recentOrderAlert: document.querySelector("#recentOrderAlert"),
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

function formatUnit(value) {
  return String(value || "pcs").trim() || "pcs";
}

function normalizeStockItem(item) {
  return {
    id: item.id || generateUUID(),
    name: item.name || "",
    category: item.category || "",
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
  const query = el.stockSearch.value.trim().toLowerCase();
  const supplierFilter = el.supplierFilter.value || "all";

  const visibleStocks = state.stocks.filter((item) => {
    const matchesQuery = [item.name, item.category, supplierName(item.supplierId)]
      .join(" ")
      .toLowerCase()
      .includes(query);
    const matchesSupplier = supplierFilter === "all" || item.supplierId === supplierFilter;
    return matchesQuery && matchesSupplier;
  });

  if (!visibleStocks.length) {
    el.stockTable.innerHTML = `<tr><td colspan="4" class="empty">No stock items found.</td></tr>`;
    return;
  }

  el.stockTable.innerHTML = visibleStocks
    .map((item) => {
      return `
        <tr>
          <td data-label="Item">
            <div class="item-name">${escapeHtml(item.name)}</div>
            <div class="subtle">${escapeHtml(item.category || "Uncategorised")}</div>
          </td>
          <td data-label="Supplier">${escapeHtml(supplierName(item.supplierId))}</td>
          <td data-label="Unit">${escapeHtml(formatUnit(item.unit))}</td>
          <td data-label="Actions">
            <div class="row-actions">
              <button class="icon-btn" type="button" data-action="quick-order" data-id="${item.id}" title="Add to order">Order</button>
              <button class="icon-btn danger-soft" type="button" data-action="delete-stock" data-id="${item.id}" title="Delete item">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderSupplierList() {
  if (!state.suppliers.length) {
    el.supplierList.innerHTML = `<div class="empty">Add your first supplier above.</div>`;
    return;
  }

  el.supplierList.innerHTML = state.suppliers
    .map((supplier) => {
      const count = state.stocks.filter((item) => item.supplierId === supplier.id).length;
      return `
        <div class="supplier-card">
          <div>
            <strong>${escapeHtml(supplier.name)}</strong>
            <div class="supplier-meta">Email: ${escapeHtml(supplier.email || "None")} · Phone: ${escapeHtml(supplier.phone || "None")}</div>
            <div class="supplier-meta">${count} stock item${count === 1 ? "" : "s"}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function handleSearchInput() {
  const query = el.orderItemSearchInput.value.trim().toLowerCase();
  
  if (!query) {
    el.searchSuggestionsBox.style.display = "none";
    return;
  }

  const matches = state.stocks.filter((item) => 
    item.name.toLowerCase().includes(query) || 
    supplierName(item.supplierId).toLowerCase().includes(query)
  );

  if (!matches.length) {
    el.searchSuggestionsBox.innerHTML = `<div class="suggestion-item" style="color:var(--muted); cursor:default;">No items match your search.</div>`;
    el.searchSuggestionsBox.style.display = "block";
    return;
  }

  el.searchSuggestionsBox.innerHTML = matches
    .map((item) => {
      const vendor = supplierName(item.supplierId);
      return `
        <div class="suggestion-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="vendor-tag">Supplier: ${escapeHtml(vendor)}</span>
        </div>
      `;
    })
    .join("");
  
  el.searchSuggestionsBox.style.display = "block";
}

function renderBifurcatedOrders() {
  if (!state.order.length) {
    el.bifurcatedOrderContainer.innerHTML = `<div class="empty">Your order details log is currently empty.</div>`;
    return;
  }

  const groups = {};
  state.order.forEach((line) => {
    if (!groups[line.supplierId]) groups[line.supplierId] = [];
    groups[line.supplierId].push(line);
  });

  el.bifurcatedOrderContainer.innerHTML = Object.keys(groups)
    .map((supplierId) => {
      const supplier = state.suppliers.find((s) => s.id === supplierId);
      const vendorName = supplier ? supplier.name : "Unknown Supplier";
      const lines = groups[supplierId];

      const rowsHtml = lines
        .map((line) => {
          const item = state.stocks.find((s) => s.id === line.itemId);
          return `
            <div class="order-card" style="margin-left: 8px; border-left: 3px solid var(--primary); background: #fff; padding: 10px; margin-bottom: 6px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <strong>${escapeHtml(item?.name || "Deleted item")}</strong>
                  <div class="order-meta">Qty: ${formatNumber(line.quantity)} ${escapeHtml(item?.unit || "")}</div>
                </div>
                <button class="icon-btn danger-soft" type="button" data-action="remove-line" data-id="${line.id}">Remove</button>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="supplier-order-group" style="margin-bottom: 24px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: #fafbfc;">
          <h3 style="margin: 0 0 12px 0; color: var(--primary); font-size: 1.1rem; border-bottom: 2px solid var(--line); padding-bottom: 6px;">
            📦 ${escapeHtml(vendorName)} (${lines.length} items)
          </h3>
          
          <div style="margin-bottom: 14px;">${rowsHtml}</div>
          
          <div class="order-actions" style="display: flex; gap: 8px; margin-top: 10px;">
            <button class="primary small-action" type="button" data-action="whatsapp-vendor" data-supplier-id="${supplierId}">Share to WhatsApp</button>
            <button class="secondary small-action" type="button" data-action="email-vendor" data-supplier-id="${supplierId}">Mail Order</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function addOrUpdateOrderLine(item, quantity) {
  const existing = state.order.find((line) => line.itemId === item.id);
  if (existing) {
    existing.quantity = Number(existing.quantity) + Number(quantity);
  } else {
    state.order.push({
      id: generateUUID(),
      supplierId: item.supplierId,
      itemId: item.id,
      quantity: Number(quantity),
      note: ""
    });
  }
}

function buildCleanTextPayload(supplierId) {
  const lines = state.order.filter((line) => line.supplierId === supplierId);
  return lines.map((line, idx) => {
    const item = state.stocks.find((s) => s.id === line.itemId);
    return `${idx + 1}. ${item?.name || "Item"} - ${line.quantity} ${item?.unit || ""}`;
  }).join("\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el.subTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    showSubPage(btn.dataset.subTarget);
  });
});

// Autocomplete Dropdown Selection Fix
el.searchSuggestionsBox.addEventListener("click", (event) => {
  const suggestionItem = event.target.closest(".suggestion-item");
  if (!suggestionItem || !suggestionItem.dataset.id) return;

  el.orderItemSearchInput.value = suggestionItem.dataset.name;
  el.hiddenOrderItemId.value = suggestionItem.dataset.id;
  
  // Forces the suggestion window to clear out and close immediately
  el.searchSuggestionsBox.style.display = "none";
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-suggest-container")) {
    el.searchSuggestionsBox.style.display = "none";
  }
});

el.orderItemSearchInput.addEventListener("input", handleSearchInput);
el.orderItemSearchInput.addEventListener("focus", handleSearchInput);

el.stockForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.stocks.push({
    id: generateUUID(),
    name: document.querySelector("#itemName").value.trim(),
    category: document.querySelector("#itemCategory").value.trim(),
    supplierId: el.itemSupplier.value,
    unit: formatUnit(document.querySelector("#itemUnit").value)
  });
  saveState();
  el.stockForm.reset();
  document.querySelector("#itemUnit").value = "pcs";
  render();
});

el.supplierForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.suppliers.push({
    id: generateUUID(),
    name: document.querySelector("#supplierName").value.trim(),
    email: document.querySelector("#supplierEmail").value.trim(),
    phone: document.querySelector("#supplierPhone").value.trim().replace(/[^0-9+]/g, "")
  });
  saveState();
  el.supplierForm.reset();
  render();
});

el.orderForm.addEventListener("submit", (event) => {
  event.preventDefault();
  
  const selectedItemId = el.hiddenOrderItemId.value;
  const item = state.stocks.find((stock) => stock.id === selectedItemId);
  
  if (!item || el.orderItemSearchInput.value !== item.name) {
    alert("Please select a valid item from the search suggestion menu popup.");
    return;
  }

  const qty = document.querySelector("#orderQty").value;

  addOrUpdateOrderLine(item, qty);
  saveState();

  el.orderForm.reset();
  el.hiddenOrderItemId.value = "";
  document.querySelector("#orderQty").value = 1;

  el.recentOrderAlert.innerHTML = `
    <div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">
      ✔ Added: ${escapeHtml(item.name)} (Qty: ${qty})
    </div>
  `;
  el.recentOrderAlert.style.display = "block";

  render();
});

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

  if (action === "quick-order") {
    const item = state.stocks.find((stock) => stock.id === id);
    if (!item) return;
    addOrUpdateOrderLine(item, 1);
    
    el.orderItemSearchInput.value = item.name;
    el.hiddenOrderItemId.value = item.id;
    
    el.recentOrderAlert.innerHTML = `
      <div style="background: var(--ok-bg); color: var(--ok-text); padding: 12px; border-radius: 6px; font-size: 0.9rem; border: 1px solid rgba(36,113,58,0.15)">
        ✔ Added: ${escapeHtml(item.name)} (Qty: 1)
      </div>
    `;
    el.recentOrderAlert.style.display = "block";
    showPage("orderPage");
  }

  saveState();
  render();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "remove-line") {
    if (confirm("Remove this item line from this supplier's active purchase order list?")) {
      state.order = state.order.filter((line) => line.id !== button.dataset.id);
      saveState();
      render();
    }
  }

  if (action === "whatsapp-vendor") {
    const sId = button.dataset.supplierId;
    const supplier = state.suppliers.find((s) => s.id === sId);
    if (!supplier) return;
    
    const itemsText = buildCleanTextPayload(sId);
    const textMessage = `Hello ${supplier.name},\n\nPlease arrange delivery for the following purchase items:\n\n${itemsText}\n\nThank you.`;
    const cleanPhone = (supplier.phone || "").replace(/[^0-9]/g, "");
    
    window.open(`https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(textMessage)}`, "_blank");
  }

  if (action === "email-vendor") {
    const sId = button.dataset.supplierId;
    const supplier = state.suppliers.find((s) => s.id === sId);
    if (!supplier) return;
    
    const itemsText = buildCleanTextPayload(sId);
    const emailBody = `Hello ${supplier.name},\n\nPlease process the following order for our shop:\n\n${itemsText}\n\nThank you.`;
    
    window.location.href = `mailto:${encodeURIComponent(supplier.email || "")}?subject=${encodeURIComponent("Shop Purchase Order Request")}&body=${encodeURIComponent(emailBody)}`;
  }
});

el.stockSearch.addEventListener("input", renderStockTable);
el.supplierFilter.addEventListener("change", renderStockTable);

el.tabButtons.forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.pageTarget));
});

document.querySelector("#resetDemoBtn").addEventListener("click", () => {
  if (confirm("Reset application data to clear custom logs and load defaults?")) {
    state = structuredClone(sampleState);
    saveState();
    el.recentOrderAlert.style.display = "none";
    render();
  }
});

document.querySelector("#exportDataBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "shop-stock-data.json";
  link.click();
});

function initializeApp() {
  renderSupplierOptions();
  if (state.suppliers.length > 0 && !el.itemSupplier.value) {
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
