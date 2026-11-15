// Test preload (bunfig.toml). Tests mock global `fetch`; if the on-disk model
// catalog happened to be expired, the automatic refresh in
// `ensureModelCatalogFresh()` would consume (and miscount) those mocked calls.
// Turn automatic refreshes off (the `catalog_refresh` setting) before every test,
// so results never depend on the catalog's age. Everything is left editable, so
// tests that exercise settings need no policy of their own.
// Tests that exercise refreshing call `refreshModelCatalog()` explicitly.
import { beforeEach } from "bun:test";
import { SETTING_KEYS, setConfigs } from "../src/config/settings.ts";

beforeEach(() => {
  setConfigs({ values: { catalog_refresh: "off" }, editable: [...SETTING_KEYS] });
});
