const STORAGE_KEY = "shop-stock-order-app-v4";

const sampleState = {
  suppliers: [
    { id: crypto.randomUUID(), name: "Sunrise Traders", email: "orders@sunrisetraders.example", phone: "9876543210" },
    { id: crypto.randomUUID(), name: "City Wholesale", email: "sales@citywholesale.example", phone: "9123456780" },
    { id: crypto.randomUUID(), name: "Fresh Pack Supplies", email: "", phone: "9000011122" }
  ],
  stocks: [],
  order: []
};

sampleState.stocks = [
  { id: crypto.randomUUID(), name: "Basmati Rice 5kg", category: "Grocery", supplierId: sampleState.suppliers[0].id, unit: "bags" },
  { id: crypto.randomUUID(), name: "Toor Dal 1kg", category: "Grocery", supplierId: sampleState.suppliers[0].id, unit: "packs" },
  { id: crypto.randomUUID(), name: "Dishwash Liquid 500ml", category: "Cleaning", supplierId: sampleState.suppliers[1].id, unit: "bottles" },
  { id: crypto.randomUUID(), name: "Paper Carry Bags Medium", category: "Packing", supplierId: sampleState.suppliers[2].id, unit: "bundles" }
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
  orderItem: document.querySelector("#orderItem"),
  supplierFilter: document.querySelector("#supplierFilter"),
  stockSearch: document.querySelector("#stockSearch"),
  recentOrderAlert: document.querySelector("#recentOrderAlert"),
  addDataDropdownBtn: document.querySelector("#addDataDropdownBtn"),
  addDataDropdownMenu: document.querySelector("#addDataDropdownMenu"),
  pages: document.querySelectorAll(".page"),
  tabButtons: document.querySelectorAll(".tab-button")
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
    id: item.id || crypto.randomUUID(),
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
  renderAllOrderItems();
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

  // Track state highlight changes for dropdown trigger highlights
  const insideMenuButtons = ["stockPage", "supplierPage", "dataPage"];
  if (insideMenuButtons.includes(pageId)) {
    el.addDataDropdownBtn.classList.add("active");
  } else {
    el.addDataDropdownBtn.classList.remove("active");
  }

  if (location.hash !== `#${pageId}`) {
    history.replaceState(null, "", `#${pageId}`);
  }
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

function renderAllOrderItems() {
  if (!state.stocks.length) {
    el.orderItem.innerHTML = `<option value="">No stock items available. Add some first!</option>`;
    return;
  }

  el.orderItem.innerHTML = state.stocks
    .map((item) => {
      const vendorName = supplierName(item.supplierId);
      return `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(vendorName)})</option>`;
    })
    .join("");
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
                  <div class="order-meta">Qty: ${formatNumber(line.quantity)} ${escapeHtml(item?.unit || "")}${line.note ? ` · ${escapeHtml(line.note)}` : ""}</div>
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

function addOrUpdateOrderLine(item, quantity, note = "") {
  const existing = state.order.find((line) => line.itemId === item.id);
  if (existing) {
    existing.quantity = Number(existing.quantity) + Number(quantity);
    existing.note = note || existing.note;
  } else {
    state.order.push({
      id: crypto.randomUUID(),
      supplierId: item.supplierId,
      itemId: item.id,
      quantity: Number(quantity),
      note
    });
  }
}

function buildCleanTextPayload(supplierId) {
  const lines = state.order.filter((line) => line.supplierId === supplierId);
  return lines.map((line, idx) => {
    const item = state.stocks.find((s) => s.id === line.itemId);
    return `${idx + 1}. ${item?.name || "Item"} - ${line.quantity} ${item?.unit || ""}${line.note ? ` (${line.note})` : ""}`;
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

// Dropdown interface interaction toggle
el.addDataDropdownBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  el.addDataDropdownMenu.classList.toggle("show");
});

document.addEventListener("click", () => {
  el.addDataDropdownMenu.classList.remove("show");
});

el.addDataDropdownMenu.addEventListener("click", (event) => {
  const targetBtn = event.target.closest("button[data-page-target]");
  if (!targetBtn) return;
  showPage(targetBtn.dataset.pageTarget);
});

el.stockForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.stocks.push({
    id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
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
  const item = state.stocks.find((stock) => stock.id === el.orderItem.value);
  if (!item) return;

  const qty = document.querySelector("#orderQty").value;
  const note = document.querySelector("#orderNote").value.trim();

  addOrUpdateOrderLine(item, qty, note);
  saveState();

  document.querySelector("#orderQty").value = 1;
  document.querySelector("#orderNote").value = "";

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
    state.stocks = state.stocks.filter((item) => item.id !== id);
    state.order = state.order.filter((line) => line.itemId !== id);
  }

  if (action === "quick-order") {
    const item = state.stocks.find((stock) => stock.id === id);
    if (!item) return;
    addOrUpdateOrderLine(item, 1);
    el.orderItem.value = item.id;
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
    state.order = state.order.filter((line) => line.id !== button.dataset.id);
    saveState();
    render();
  }

  if (action === "whatsapp-vendor") {
    const sId = button.dataset.supplierId;
    const supplier = state.suppliers.find((s) => s.id === sId);
    if (!supplier) return;
    
    const itemsText = buildCleanTextPayload(sId);
    const textMessage = `Hello ${supplier.name},\n\nPlease arrange delivery for the following purchase items:\n\n${itemsText}\n\nThank you.`;
    
    // Grabs phone digits, defaulting clean tracking window routing if missing
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
  state = structuredClone(sampleState);
  saveState();
  el.recentOrderAlert.style.display = "none";
  render();
});

document.querySelector("#exportDataBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "shop-stock-data.json";
  link.click();
});

document.querySelector("#exportCsvBtn").addEventListener("click", exportCsv);
document.querySelector("#exportExcelBtn").addEventListener("click", exportExcel);

function initializeApp() {
  renderSupplierOptions();
  if (state.suppliers.length > 0 && !el.itemSupplier.value) {
    el.itemSupplier.value = state.suppliers[0].id;
  }
  renderStockTable();
  renderSupplierList();
  renderAllOrderItems();
  renderBifurcatedOrders();
}

initializeApp();

if (location.hash) {
  const pageId = location.hash.slice(1);
  if (document.getElementById(pageId)) {
    showPage(pageId);
  }
}
