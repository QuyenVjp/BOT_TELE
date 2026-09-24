const BOT_TELE_INTAKE_BASE_URL = "https://api.tier20.click";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("BOT_TELE")
    .addItem("➕ Nhập tài khoản", "showInventorySidebar")
    .addToUi();
}

function showInventorySidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar").setTitle("Nhập tài khoản");
  SpreadsheetApp.getUi().showSidebar(html);
}

function getSpreadsheetId_() {
  return SpreadsheetApp.getActiveSpreadsheet().getId();
}

function callInventoryApi_(path, payload) {
  const token = ScriptApp.getIdentityToken();
  const response = UrlFetchApp.fetch(BOT_TELE_INTAKE_BASE_URL + path, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(Object.assign({}, payload, { spreadsheetId: getSpreadsheetId_() })),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    body = { ok: false, code: "INVALID_SERVER_RESPONSE" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, code: body.code || "REQUEST_FAILED", preview: body.preview };
  }
  return body;
}

function getInventoryVariants() {
  return callInventoryApi_("/ops/google-sheets/inventory-intake/catalog", {});
}

function previewInventory(payload) {
  return callInventoryApi_("/ops/google-sheets/inventory-intake/preview", payload);
}

function confirmInventory(payload) {
  return callInventoryApi_("/ops/google-sheets/inventory-intake/confirm", payload);
}
