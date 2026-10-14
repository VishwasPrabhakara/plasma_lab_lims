// Project parameter panels — mirrors the lab's Excel workbook.
// Each parameter row: { name, unit, std, reps }.
// Standards intentionally blank where the workbook leaves them blank; the
// operator note says "Check standards wrt project requirements", i.e. the
// analyst types the correct limit per sample.

import { STORAGE_KEYS } from "../config.js";

export const PARAM = (name, unit = "", std = "", reps = 3) => ({ name, unit, std, reps });

export const PROJECT_PANELS = {
  "Devanahalli": [
    PARAM("pH", ""), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"), PARAM("TSS", "mg/L"),
    PARAM("TN", "mg/L"), PARAM("NH4-N", "mg/L"), PARAM("PO4-P", "mg/L"),
    PARAM("Faecal Coliform", "MPN/100mL"), PARAM("Turbidity", "NTU"), PARAM("Fluoride", "mg/L")
  ],
  "V Valley": [
    PARAM("pH", ""), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"), PARAM("TSS", "mg/L"),
    PARAM("TN", "mg/L"), PARAM("NH4-N", "mg/L"), PARAM("PO4-P", "mg/L"),
    PARAM("Faecal Coliform", "MPN/100mL"), PARAM("Hardness", "mg/L"), PARAM("Fluoride", "mg/L")
  ],
  "HN Valley": [
    PARAM("pH", ""), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"), PARAM("TSS", "mg/L"),
    PARAM("TN", "mg/L"), PARAM("NH4-N", "mg/L"), PARAM("PO4-P", "mg/L"),
    PARAM("Faecal Coliform", "MPN/100mL")
  ],
  "KC Valley Water": [
    PARAM("pH", ""), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"), PARAM("TSS", "mg/L"),
    PARAM("TN", "mg/L"), PARAM("NH4-N", "mg/L"), PARAM("PO4-P", "mg/L"),
    PARAM("Faecal Coliform", "MPN/100mL")
  ],
  "KC Valley Soil": [
    PARAM("pH", ""), PARAM("EC", "microS/cm"), PARAM("Sand", "%"), PARAM("Clay", "%"),
    PARAM("Silt", "%"), PARAM("Salinity", "ppt"), PARAM("Organic Matter", "%"),
    PARAM("Nitrate", "mg/kg"), PARAM("Avail Phosphorus", "mg/kg")
  ],
  "Karwar Water": [
    PARAM("pH", ""), PARAM("Temp", "°C"), PARAM("Turbidity", "NTU"),
    PARAM("EC", "microS/cm"), PARAM("TSS", "mg/L"), PARAM("Salinity", "ppt"),
    PARAM("DO", "mg/L"), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"),
    PARAM("NO2-N", "mg/L"), PARAM("NO3-N", "mg/L"), PARAM("Phosphate", "mg/L"),
    PARAM("Oil and Grease", "mg/L")
  ],
  "Karwar Soil": [
    PARAM("pH", ""), PARAM("Sand", "%"), PARAM("Silt", "%"), PARAM("Clay", "%"),
    PARAM("Organic Matter", "%"), PARAM("Porosity", "%"), PARAM("NO3-N", "mg/kg"),
    PARAM("PO4-P", "mg/kg"), PARAM("K", "mg/kg"), PARAM("Salinity", "ppt")
  ],
  "L&T": [
    PARAM("COD", "mg/L"), PARAM("BOD", "mg/L"), PARAM("TKN", "mg/L"),
    PARAM("PO4-P", "mg/L"), PARAM("NH3-N", "mg/L"), PARAM("TN", "mg/L"),
    PARAM("NO3-N", "mg/L"), PARAM("NO2-N", "mg/L")
  ],
  "KAPL": [
    PARAM("pH", ""), PARAM("BOD", "mg/L"), PARAM("COD", "mg/L"), PARAM("TSS", "mg/L"),
    PARAM("TN", "mg/L"), PARAM("NH4-N", "mg/L"), PARAM("PO4-P", "mg/L"),
    PARAM("Faecal Coliform", "MPN/100mL")
  ]
};

// Admin-defined panels persist in localStorage and override the hard defaults
// above. This lets an admin add a new project's panel, or change parameters
// without any backend deploy.
export function loadCustomPanels() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.customPanels);
    if (!raw) return;
    const custom = JSON.parse(raw);
    if (custom && typeof custom === "object") Object.assign(PROJECT_PANELS, custom);
  } catch (e) {
    console.warn("Custom panels could not be loaded:", e);
  }
}

export function getCustomPanels() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.customPanels) || "{}") || {}; }
  catch { return {}; }
}

export function saveCustomPanel(name, params) {
  const all = getCustomPanels();
  all[name] = params;
  localStorage.setItem(STORAGE_KEYS.customPanels, JSON.stringify(all));
  Object.assign(PROJECT_PANELS, { [name]: params });
}

export function deleteCustomPanel(name) {
  const all = getCustomPanels();
  delete all[name];
  localStorage.setItem(STORAGE_KEYS.customPanels, JSON.stringify(all));
  // Note: this does NOT remove the panel from PROJECT_PANELS in memory if it was
  // a hard default. A full reload reverts to the default. Fine for v1.
}

// Given clientName / collectionSite, match a panel name (case-insensitive).
// Longest key first so "KC Valley Soil" beats "KC Valley Water".
export function guessPanelName(sample) {
  const hay = ((sample?.clientName || "") + " " + (sample?.collectionSite || "")).toLowerCase();
  const keys = Object.keys(PROJECT_PANELS).sort((a, b) => b.length - a.length);
  return keys.find(k => hay.includes(k.toLowerCase())) || "";
}
