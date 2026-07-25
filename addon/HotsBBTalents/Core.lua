-- HotsBB Talents — Phase 2 proof of concept: import panel only (no compliance overlay yet).
--
-- KNOWN UNCERTAINTY (flagged for whoever tests this in-game, since it can't be verified
-- without a live client): the exact calling convention for C_ClassTalents.ImportLoadout on
-- this patch. The 4-argument form (configID, entries, name, importString) was documented as
-- added in patch 11.2.5; passing an empty `entries` table and relying on the raw `importString`
-- is the best-effort interpretation of that signature. If ImportBuild() below errors or silently
-- does nothing in-game, that call is the first place to check — the Copy fallback (paste into
-- the built-in Talents > Import dialog) always works regardless, since it doesn't depend on any
-- addon API guess.

local ADDON_NAME = ...

-- ── Helpers ──────────────────────────────────────────────────────────────────

local function GetCurrentSpecID()
  local specIndex = GetSpecialization and GetSpecialization()
  if not specIndex then return nil end
  local specID = GetSpecializationInfo(specIndex)
  return specID
end

local function ImportBuild(importString, displayName)
  if not importString then
    print("|cffff4444HotsBB Talents:|r No import string for this build.")
    return false
  end
  if not (C_ClassTalents and C_ClassTalents.ImportLoadout and C_ClassTalents.GetActiveConfigID) then
    print("|cffff4444HotsBB Talents:|r Talent import API not found on this client. Use Copy and paste into the in-game Talents > Import dialog instead.")
    return false
  end
  local configID = C_ClassTalents.GetActiveConfigID()
  if not configID then
    print("|cffff4444HotsBB Talents:|r Could not find your active talent config. Open the Talents panel once, then try again.")
    return false
  end
  local ok, success, importError = pcall(C_ClassTalents.ImportLoadout, configID, {}, displayName or "HotsBB Meta Build", importString)
  if not ok then
    print("|cffff4444HotsBB Talents:|r Import call errored (" .. tostring(success) .. "). Use Copy and paste manually instead.")
    return false
  end
  if not success then
    print("|cffff4444HotsBB Talents:|r Import rejected (" .. tostring(importError) .. "). Use Copy and paste manually instead.")
    return false
  end
  print("|cff44ff44HotsBB Talents:|r Imported \"" .. (displayName or "build") .. "\" — review it in your Talents panel before applying.")
  return true
end

-- ── Copy-string popup (guaranteed-safe fallback: no addon API dependency) ────

local copyFrame = CreateFrame("Frame", "HotsBBTalentsCopyFrame", UIParent, "BasicFrameTemplateWithInset")
copyFrame:SetSize(420, 120)
copyFrame:SetPoint("CENTER")
copyFrame:SetMovable(true)
copyFrame:EnableMouse(true)
copyFrame:RegisterForDrag("LeftButton")
copyFrame:SetScript("OnDragStart", copyFrame.StartMoving)
copyFrame:SetScript("OnDragStop", copyFrame.StopMovingOrSizing)
copyFrame:SetFrameStrata("DIALOG")
copyFrame:Hide()
copyFrame.title = copyFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
copyFrame.title:SetPoint("LEFT", copyFrame.TitleBg, "LEFT", 5, 0)
copyFrame.title:SetText("Copy build string (Ctrl+C, then paste into Talents > Import)")

local copyBox = CreateFrame("EditBox", nil, copyFrame, "InputBoxTemplate")
copyBox:SetSize(380, 20)
copyBox:SetPoint("TOP", 0, -40)
copyBox:SetAutoFocus(false)
copyBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)

local function ShowCopyBox(importString)
  copyBox:SetText(importString or "")
  copyFrame:Show()
  copyBox:SetFocus()
  copyBox:HighlightText()
end

-- ── Main panel ───────────────────────────────────────────────────────────────

local frame = CreateFrame("Frame", "HotsBBTalentsFrame", UIParent, "BasicFrameTemplateWithInset")
frame:SetSize(380, 440)
frame:SetPoint("CENTER")
frame:SetMovable(true)
frame:EnableMouse(true)
frame:RegisterForDrag("LeftButton")
frame:SetScript("OnDragStart", frame.StartMoving)
frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
frame:Hide()
tinsert(UISpecialFrames, "HotsBBTalentsFrame") -- lets Esc close it like a default Blizzard panel

frame.title = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
frame.title:SetPoint("LEFT", frame.TitleBg, "LEFT", 5, 0)
frame.title:SetText("HotsBB Talents — Meta Builds")

frame.subtitle = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
frame.subtitle:SetPoint("TOPLEFT", 14, -30)
frame.subtitle:SetPoint("RIGHT", -14, 0)
frame.subtitle:SetJustifyH("LEFT")
frame.subtitle:SetText("")

local scrollFrame = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
scrollFrame:SetPoint("TOPLEFT", 14, -50)
scrollFrame:SetPoint("BOTTOMRIGHT", -32, 14)

local content = CreateFrame("Frame", nil, scrollFrame)
content:SetSize(1, 1)
scrollFrame:SetScrollChild(content)

local rowPool = {}
local function GetRow(index)
  local row = rowPool[index]
  if row then return row end
  row = CreateFrame("Frame", nil, content)
  row:SetSize(320, 54)

  row.header = row:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  row.header:SetPoint("TOPLEFT", 0, 0)
  row.header:SetPoint("RIGHT", 0, 0)
  row.header:SetJustifyH("LEFT")

  row.sub = row:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  row.sub:SetPoint("TOPLEFT", row.header, "BOTTOMLEFT", 0, -2)

  row.importBtn = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  row.importBtn:SetSize(70, 20)
  row.importBtn:SetPoint("TOPRIGHT", 0, -2)
  row.importBtn:SetText("Import")

  row.copyBtn = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  row.copyBtn:SetSize(60, 20)
  row.copyBtn:SetPoint("RIGHT", row.importBtn, "LEFT", -4, 0)
  row.copyBtn:SetText("Copy")

  row.sep = row:CreateTexture(nil, "ARTWORK")
  row.sep:SetHeight(1)
  row.sep:SetPoint("BOTTOMLEFT", 0, -6)
  row.sep:SetPoint("BOTTOMRIGHT", 0, -6)
  row.sep:SetColorTexture(1, 1, 1, 0.08)

  rowPool[index] = row
  return row
end

local function Refresh()
  local specID = GetCurrentSpecID()
  local _, className = UnitClass("player")

  for _, row in ipairs(rowPool) do row:Hide() end

  if not specID then
    frame.subtitle:SetText("Could not detect your current specialization.")
    return
  end

  local specData = HotsBBTalentsData and HotsBBTalentsData[specID]
  if not specData then
    frame.subtitle:SetText("No meta build data bundled for this spec yet (spec ID " .. specID .. ").")
    return
  end

  frame.subtitle:SetText("Bundled builds for your current spec. Data refreshes with each addon update.")

  local rowIndex = 0
  local y = 0
  for bossName, bossEntry in pairs(specData) do
    for _, variant in ipairs(bossEntry.variants or {}) do
      rowIndex = rowIndex + 1
      local row = GetRow(rowIndex)
      row:ClearAllPoints()
      row:SetPoint("TOPLEFT", content, "TOPLEFT", 0, -y)
      row:SetPoint("RIGHT", content, "RIGHT", 0, 0)

      local label = bossName
      if variant.heroTreeName and variant.heroTreeName ~= "Overall" then
        label = label .. " — " .. variant.heroTreeName
      end
      row.header:SetText(label)
      row.sub:SetText((variant.sampleSize or 0) .. " top parses")

      local importString = variant.importString
      local displayName = label
      row.importBtn:SetScript("OnClick", function() ImportBuild(importString, displayName) end)
      row.copyBtn:SetScript("OnClick", function() ShowCopyBox(importString) end)

      row:Show()
      y = y + 60
    end
  end

  content:SetSize(320, math.max(y, 1))
end

frame:SetScript("OnShow", Refresh)

-- ── Slash command ────────────────────────────────────────────────────────────

SLASH_HOTSBBTALENTS1 = "/hbt"
SLASH_HOTSBBTALENTS2 = "/hotsbbtalents"
SlashCmdList["HOTSBBTALENTS"] = function()
  if frame:IsShown() then
    frame:Hide()
  else
    frame:Show()
  end
end
