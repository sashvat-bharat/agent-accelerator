// Test preload (bunfig.toml). Tests mock global `fetch`; if the on-disk model
// catalog happened to be expired, the automatic refresh in
// `ensureModelCatalogFresh()` would consume (and miscount) those mocked calls.
// Turn automatic refreshes off (the `catalog_refresh` setting) before every test,
// so results never depend on the catalog's age. Everything is left editable, so
// tests that exercise settings need no policy of their own.
// Tests that exercise refreshing call `refreshModelCatalog()` explicitly.
// The private-host check of media downloads looks every name up in DNS and refuses one it cannot look up: give it
// one public documentation address for every name, so no test touches the network and none depends on it being up.
// Tests of the check itself install their own lookup.
import { beforeEach } from "bun:test";
import { SETTING_KEYS, setConfigs } from "../src/config/settings.ts";
import { setHostLookup } from "../src/utils/safe-io.ts";

beforeEach(() => {
  setConfigs({ values: { catalog_refresh: "off" }, editable: [...SETTING_KEYS] });
  setHostLookup(async () => ["203.0.113.10"]);
});
