// Test preload (bunfig.toml). Tests mock global `fetch`; if the on-disk model
// catalog happened to be expired, the automatic refresh in
// `ensureModelCatalogFresh()` would consume (and miscount) those mocked calls.
// Disable automatic refreshes so results never depend on the catalog's age.
// Tests that exercise refreshing call `refreshModelCatalog()` explicitly.
process.env.AGENT_CATALOG_REFRESH = "off";
