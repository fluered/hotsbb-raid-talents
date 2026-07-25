-- HotsBB Talents — Phase 2 proof of concept: import panel only (no compliance overlay yet).
--
-- Import decodes the loadout string client-side into real entries before calling
-- C_ClassTalents.ImportLoadout — a faithful Lua port of Blizzard's own decode logic
-- (ClassTalentImportExportMixin in Blizzard_ClassTalentImportExport.lua), since that
-- mixin isn't exposed for addons to call directly. STILL UNTESTED IN-GAME as of writing
-- this — this fixes the earlier confirmed bug (empty-loadout result from passing
-- entries={}), but hasn't been verified end-to-end yet. Copy remains available as a
-- guaranteed-safe fallback that doesn't depend on any of this decode logic.

local ADDON_NAME = ...

-- ── Helpers ──────────────────────────────────────────────────────────────────

local function GetCurrentSpecID()
  local specIndex = GetSpecialization and GetSpecialization()
  if not specIndex then return nil end
  local specID = GetSpecializationInfo(specIndex)
  return specID
end

-- ── Loadout string decoder ──────────────────────────────────────────────────
-- Faithful port of Blizzard's Interface/AddOns/Blizzard_PlayerSpells/ClassTalents/
-- Blizzard_ClassTalentImportExport.lua (ClassTalentImportExportMixin). Field order,
-- bit widths, and per-node logic below are copied to match that source exactly.

local BIT_WIDTH_HEADER_VERSION = 8
local BIT_WIDTH_SPEC_ID = 16
local BIT_WIDTH_RANKS_PURCHASED = 6

local function HashEquals(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do
    if a[i] ~= b[i] then return false end
  end
  return true
end

local function IsHashEmpty(hash)
  for _, v in ipairs(hash) do
    if v ~= 0 then return false end
  end
  return true
end

local function ReadLoadoutHeader(importStream)
  local serializationVersion = importStream:ExtractValue(BIT_WIDTH_HEADER_VERSION)
  local specID = importStream:ExtractValue(BIT_WIDTH_SPEC_ID)
  local treeHash = {}
  for i = 1, 16 do
    treeHash[i] = importStream:ExtractValue(8)
  end
  return serializationVersion, specID, treeHash
end

local function ReadLoadoutContent(importStream, treeID)
  local results = {}
  local treeNodes = C_Traits.GetTreeNodes(treeID)
  for i = 1, #treeNodes do
    local isNodeSelected = importStream:ExtractValue(1) == 1
    local isNodePurchased = false
    local isPartiallyRanked = false
    local partialRanksPurchased = 0
    local isChoiceNode = false
    local choiceNodeSelection = 0

    if isNodeSelected then
      isNodePurchased = importStream:ExtractValue(1) == 1
      if isNodePurchased then
        isPartiallyRanked = importStream:ExtractValue(1) == 1
        if isPartiallyRanked then
          partialRanksPurchased = importStream:ExtractValue(BIT_WIDTH_RANKS_PURCHASED)
        end
        isChoiceNode = importStream:ExtractValue(1) == 1
        if isChoiceNode then
          choiceNodeSelection = importStream:ExtractValue(2)
        end
      end
    end

    results[i] = {
      isNodeSelected = isNodeSelected,
      isNodeGranted = isNodeSelected and not isNodePurchased,
      isPartiallyRanked = isPartiallyRanked,
      partialRanksPurchased = partialRanksPurchased,
      isChoiceNode = isChoiceNode,
      choiceNodeSelection = choiceNodeSelection + 1,
    }
  end
  return results
end

local function CreateEntryFromSingleNode(results, treeNodeInfo, indexInfo)
  if not treeNodeInfo or not indexInfo or not indexInfo.isNodeSelected then return end

  local result = { nodeID = treeNodeInfo.ID }
  result.ranksGranted = indexInfo.isNodeGranted and 1 or 0
  if indexInfo.isNodeSelected and not indexInfo.isNodeGranted then
    result.ranksPurchased = indexInfo.isPartiallyRanked and indexInfo.partialRanksPurchased or treeNodeInfo.maxRanks
  else
    result.ranksPurchased = 0
  end

  result.selectionEntryID = nil
  if indexInfo.isChoiceNode and indexInfo.choiceNodeSelection then
    result.selectionEntryID = treeNodeInfo.entryIDs[indexInfo.choiceNodeSelection]
  elseif treeNodeInfo.activeEntry then
    result.selectionEntryID = treeNodeInfo.activeEntry.entryID
  end
  if not result.selectionEntryID then
    result.selectionEntryID = treeNodeInfo.entryIDs[1]
  end

  if result.selectionEntryID ~= nil then
    table.insert(results, result)
  end
end

local function CreateEntryFromTieredNode(results, configID, treeNodeInfo, indexInfo)
  if not treeNodeInfo or not indexInfo or not indexInfo.isNodeSelected then return end

  local totalRanksPurchased = 0
  if not indexInfo.isNodeGranted then
    totalRanksPurchased = indexInfo.isPartiallyRanked and indexInfo.partialRanksPurchased or treeNodeInfo.maxRanks
  end

  local remainingRanks = totalRanksPurchased
  for index, entryID in ipairs(treeNodeInfo.entryIDs) do
    local entryInfo = C_Traits.GetEntryInfo(configID, entryID)
    if entryInfo then
      local ranksForThisEntry = math.min(remainingRanks, entryInfo.maxRanks)
      local isGranted = indexInfo.isNodeGranted and (index == 1)
      if ranksForThisEntry > 0 or isGranted then
        table.insert(results, {
          nodeID = treeNodeInfo.ID,
          ranksGranted = isGranted and 1 or 0,
          ranksPurchased = ranksForThisEntry,
          selectionEntryID = entryID,
        })
      end
      remainingRanks = remainingRanks - ranksForThisEntry
    end
  end
end

local function ConvertToImportLoadoutEntryInfo(configID, treeID, loadoutContent)
  local results = {}
  local treeNodes = C_Traits.GetTreeNodes(treeID)
  for index, treeNodeID in ipairs(treeNodes) do
    local indexInfo = loadoutContent[index]
    local treeNodeInfo = C_Traits.GetNodeInfo(configID, treeNodeID)
    if treeNodeInfo then
      if treeNodeInfo.type == Enum.TraitNodeType.Tiered then
        CreateEntryFromTieredNode(results, configID, treeNodeInfo, indexInfo)
      else
        CreateEntryFromSingleNode(results, treeNodeInfo, indexInfo)
      end
    end
  end
  return results
end

-- Decodes a Blizzard talent loadout string into ImportLoadoutEntryInfo[] ready for
-- C_ClassTalents.ImportLoadout. Returns entries, nil on success or nil, errorMessage on failure.
local function DecodeLoadoutString(importString, configID, treeID)
  if not (ExportUtil and ExportUtil.MakeImportDataStream) then
    return nil, "ExportUtil.MakeImportDataStream not found on this client"
  end
  local cleaned = importString:gsub("^talents=", "")
  local importStream = ExportUtil.MakeImportDataStream(cleaned)

  local okHeader, serializationVersion, specID, treeHash = pcall(ReadLoadoutHeader, importStream)
  if not okHeader then
    return nil, "Failed to read loadout header: " .. tostring(serializationVersion)
  end

  if C_Traits.GetLoadoutSerializationVersion and serializationVersion ~= C_Traits.GetLoadoutSerializationVersion() then
    return nil, "Loadout string version mismatch — likely from a different patch"
  end
  local currentSpecID = GetCurrentSpecID()
  if currentSpecID and specID ~= currentSpecID then
    return nil, "This build is for a different specialization than your current one"
  end
  if not IsHashEmpty(treeHash) and C_Traits.GetTreeHash then
    local currentHash = C_Traits.GetTreeHash(treeID)
    if currentHash and not HashEquals(treeHash, currentHash) then
      return nil, "Talent tree has changed since this build was recorded"
    end
  end

  local okContent, content = pcall(ReadLoadoutContent, importStream, treeID)
  if not okContent then
    return nil, "Failed to read loadout content: " .. tostring(content)
  end

  local okEntries, entries = pcall(ConvertToImportLoadoutEntryInfo, configID, treeID, content)
  if not okEntries then
    return nil, "Failed to build entries: " .. tostring(entries)
  end
  if #entries == 0 then
    return nil, "Decoded loadout has no talents selected"
  end

  return entries, nil
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

  if not (C_Traits and C_Traits.GetConfigInfo and C_Traits.GetTreeNodes and C_Traits.GetNodeInfo) then
    Announce("|cffff4444HotsBB Talents:|r C_Traits API not found on this client. Use Copy instead.", 1.0, 0.3, 0.3)
    return false
  end
  local configInfo = C_Traits.GetConfigInfo(configID)
  local treeID = configInfo and configInfo.treeIDs and configInfo.treeIDs[1]
  if not treeID then
    Announce("|cffff4444HotsBB Talents:|r Could not determine your talent tree ID. Use Copy instead.", 1.0, 0.3, 0.3)
    return false
  end

  local entries, decodeErr = DecodeLoadoutString(importString, configID, treeID)
  if not entries then
    Announce("|cffff4444HotsBB Talents:|r Decode failed: " .. tostring(decodeErr) .. ". Use Copy instead.", 1.0, 0.3, 0.3)
    return false
  end

  local ok, success, importError = pcall(C_ClassTalents.ImportLoadout, configID, entries, displayName or "HotsBB Meta Build", importString)
  if not ok then
    Announce("|cffff4444HotsBB Talents:|r Import call errored (" .. tostring(success) .. "). Use Copy and paste manually instead.", 1.0, 0.3, 0.3)
    return false
  end
  if not success then
    Announce("|cffff4444HotsBB Talents:|r Import rejected (" .. tostring(importError) .. "). Use Copy and paste manually instead.", 1.0, 0.3, 0.3)
    return false
  end
  Announce("|cff44ff44HotsBB Talents:|r Imported \"" .. (displayName or "build") .. "\" with " .. #entries .. " talents — review it in your Talents panel before applying.", 0.3, 1.0, 0.3)
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
  row.importBtn:SetSize(90, 20)
  row.importBtn:SetPoint("TOPRIGHT", 0, -2)
  row.importBtn:SetText("Import")

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

  frame.subtitle:SetText("Import decodes the build client-side before applying. If it errors, Copy always works.")

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
