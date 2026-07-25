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

-- Failures here are easy to miss as plain chat prints in a busy chat window (this is
-- exactly what happened during testing — GetActiveConfigID() was returning nil silently).
-- Always pair a chat print with a big on-screen banner so nothing goes unnoticed again.
local function Announce(msg, r, g, b)
  print(msg)
  if UIErrorsFrame then
    UIErrorsFrame:AddMessage(msg:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""), r, g, b, 1.0)
  end
end

-- Best-effort: C_ClassTalents.GetActiveConfigID() returns nil until the Talents UI has
-- been opened at least once this session (Blizzard lazily initializes that state when the
-- frame loads). Try to nudge it open/closed once so Import works without the player having
-- to manually open their Talents panel first. Wrapped in pcall since the exact frame name
-- may differ on this patch — if none of these exist, this just silently no-ops.
local function EnsureTalentFrameLoaded()
  pcall(function()
    if C_AddOns and C_AddOns.LoadAddOn then
      C_AddOns.LoadAddOn("Blizzard_PlayerSpells")
      C_AddOns.LoadAddOn("Blizzard_ClassTalentUI")
    end
    if PlayerSpellsFrame and ShowUIPanel then
      ShowUIPanel(PlayerSpellsFrame)
      HideUIPanel(PlayerSpellsFrame)
    elseif ClassTalentFrame and ShowUIPanel then
      ShowUIPanel(ClassTalentFrame)
      HideUIPanel(ClassTalentFrame)
    end
  end)
end

local function ImportBuild(importString, displayName)
  if not importString then
    Announce("|cffff4444HotsBB Talents:|r No import string for this build.", 1.0, 0.3, 0.3)
    return false
  end
  if not (C_ClassTalents and C_ClassTalents.ImportLoadout and C_ClassTalents.GetActiveConfigID) then
    Announce("|cffff4444HotsBB Talents:|r Talent import API not found on this client. Use Copy and paste into the in-game Talents > Import dialog instead.", 1.0, 0.3, 0.3)
    return false
  end
  local configID = C_ClassTalents.GetActiveConfigID()
  if not configID then
    EnsureTalentFrameLoaded()
    configID = C_ClassTalents.GetActiveConfigID()
  end
  if not configID then
    Announce("|cffff4444HotsBB Talents:|r Could not find your active talent config. Open your Talents panel (default key: N) once, then try Import again.", 1.0, 0.3, 0.3)
    return false
  end
  local ok, success, importError = pcall(C_ClassTalents.ImportLoadout, configID, {}, displayName or "HotsBB Meta Build", importString)
  if not ok then
    Announce("|cffff4444HotsBB Talents:|r Import call errored (" .. tostring(success) .. "). Use Copy and paste manually instead.", 1.0, 0.3, 0.3)
    return false
  end
  if not success then
    Announce("|cffff4444HotsBB Talents:|r Import rejected (" .. tostring(importError) .. "). Use Copy and paste manually instead.", 1.0, 0.3, 0.3)
    return false
  end
  Announce("|cff44ff44HotsBB Talents:|r Imported \"" .. (displayName or "build") .. "\" — review it in your Talents panel before applying.", 0.3, 1.0, 0.3)
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

  -- Import is disabled: confirmed in testing that it reports success while producing an
  -- EMPTY loadout (entries={} was never a valid stand-in for a real decoded selection list —
  -- the raw importString is not auto-decoded by the API as hoped). Re-enable only once the
  -- loadout string is properly decoded into real entries client-side. See README.
  row.importBtn = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  row.importBtn:SetSize(90, 20)
  row.importBtn:SetPoint("TOPRIGHT", 0, -2)
  row.importBtn:SetText("Import")
  row.importBtn:Disable()
  row.importBtn:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOP")
    GameTooltip:SetText("Known issue: currently creates an empty loadout instead of the real build. Use Copy for now.", nil, nil, nil, nil, true)
    GameTooltip:Show()
  end)
  row.importBtn:SetScript("OnLeave", function() GameTooltip:Hide() end)

  row.copyBtn = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  row.copyBtn:SetSize(70, 20)
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

  frame.subtitle:SetText("Import is temporarily disabled (known bug). Use Copy, then paste into Talents > Import.")

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
