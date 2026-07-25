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

-- ── Build compliance overlay (Phase 3) ────────────────────────────────────────
-- Shows how your CURRENT talent selections compare to a chosen meta build directly
-- on the real Talents UI. Untested in-game as of writing this.
--
-- Safety design (this is the part that risks touching Blizzard's protected UI):
-- every overlay element below is created as a child of our OWN frame (parented to
-- UIParent), never as a child of any Blizzard frame/button. We only ever visually
-- align our frames to Blizzard's buttons via SetPoint (a read-only positional
-- reference, not a parenting relationship), and only ever READ state via
-- C_Traits.GetNodeInfo/GetActiveConfigID — never call anything that spends points
-- or otherwise mutates protected state. Refreshes are driven purely by RegisterEvent
-- and HookScript/hooksecurefunc (Blizzard's own sanctioned safe-extension APIs),
-- never by replacing or intercepting a Blizzard function's execution.
--
-- Frame path confirmed via Blizzard's own source (Blizzard_PlayerSpellsFrame.xml):
-- PlayerSpellsFrame.TalentsFrame is the ClassTalentsFrameTemplate instance, with
-- :EnumerateAllTalentButtons() and per-button :GetNodeInfo().

local overlayContainer = CreateFrame("Frame", nil, UIParent)
overlayContainer:SetFrameStrata("HIGH")

local function CreateBorderOverlay()
  local f = CreateFrame("Frame", nil, overlayContainer)
  local thickness = 2
  f.top = f:CreateTexture(nil, "OVERLAY")
  f.top:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
  f.top:SetPoint("TOPRIGHT", f, "TOPRIGHT", 0, 0)
  f.top:SetHeight(thickness)
  f.bottom = f:CreateTexture(nil, "OVERLAY")
  f.bottom:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 0, 0)
  f.bottom:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", 0, 0)
  f.bottom:SetHeight(thickness)
  f.left = f:CreateTexture(nil, "OVERLAY")
  f.left:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
  f.left:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 0, 0)
  f.left:SetWidth(thickness)
  f.right = f:CreateTexture(nil, "OVERLAY")
  f.right:SetPoint("TOPRIGHT", f, "TOPRIGHT", 0, 0)
  f.right:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", 0, 0)
  f.right:SetWidth(thickness)
  function f:SetColor(r, g, b, a)
    self.top:SetColorTexture(r, g, b, a)
    self.bottom:SetColorTexture(r, g, b, a)
    self.left:SetColorTexture(r, g, b, a)
    self.right:SetColorTexture(r, g, b, a)
  end
  return f
end

local borderPool = {}
local function GetBorderOverlay(index)
  local f = borderPool[index]
  if not f then
    f = CreateBorderOverlay()
    borderPool[index] = f
  end
  return f
end

local function ClearComplianceOverlay()
  for _, f in ipairs(borderPool) do f:Hide() end
end

-- The build currently being compared against: { frequencyPct, entryIds, label }
local activeComparisonData = nil

local META_THRESHOLD = 50 -- pick % at/above which a node counts as "the meta pick"

local function DrawComplianceOverlay()
  ClearComplianceOverlay()
  if not activeComparisonData then return end
  if not (PlayerSpellsFrame and PlayerSpellsFrame.TalentsFrame and PlayerSpellsFrame.TalentsFrame.EnumerateAllTalentButtons) then
    return
  end
  if not (C_ClassTalents and C_ClassTalents.GetActiveConfigID) then return end
  local configID = C_ClassTalents.GetActiveConfigID()
  if not configID then return end

  local ok, err = pcall(function()
    local idx = 0
    for button in PlayerSpellsFrame.TalentsFrame:EnumerateAllTalentButtons() do
      local nodeInfo = button.GetNodeInfo and button:GetNodeInfo()
      local nodeID = nodeInfo and nodeInfo.ID
      if nodeID then
        local freq = activeComparisonData.frequencyPct[nodeID]
        local playerHas = (nodeInfo.activeRank or 0) > 0
        local isMeta = freq ~= nil and freq >= META_THRESHOLD

        local color = nil
        if isMeta and not playerHas then
          color = { 1, 0.65, 0, 0.9 } -- amber: the meta build takes this, you don't
        elseif playerHas and not isMeta then
          color = { 0.55, 0.65, 1, 0.9 } -- blue: you have this, most meta builds don't
        elseif playerHas and isMeta and nodeInfo.activeEntry then
          local metaEntry = activeComparisonData.entryIds[nodeID]
          if metaEntry and nodeInfo.activeEntry.entryID ~= metaEntry then
            color = { 1, 0.3, 0.3, 0.9 } -- red: you picked the other side of a choice node
          end
        end

        if color then
          idx = idx + 1
          local ov = GetBorderOverlay(idx)
          ov:SetSize((button:GetWidth() or 36) + 6, (button:GetHeight() or 36) + 6)
          ov:ClearAllPoints()
          ov:SetPoint("CENTER", button, "CENTER", 0, 0)
          ov:SetColor(color[1], color[2], color[3], color[4])
          ov:Show()
        end
      end
    end
  end)
  if not ok then
    Announce("|cffff4444HotsBB Talents:|r Compliance overlay error: " .. tostring(err), 1.0, 0.3, 0.3)
    ClearComplianceOverlay()
  end
end

local function SetComparisonBuild(frequencyPct, entryIds, label)
  activeComparisonData = { frequencyPct = frequencyPct, entryIds = entryIds or {}, label = label }
  DrawComplianceOverlay()
  Announce("|cff44ff44HotsBB Talents:|r Comparing your talents against \"" .. label .. "\". Amber = meta pick you're missing, blue = pick most meta builds skip, red = wrong side of a choice node.", 0.3, 1.0, 0.3)
end

-- Redraw automatically when talents change or the panel is reopened, using
-- whichever build was last selected via a Compare click.
do
  local eventFrame = CreateFrame("Frame")
  eventFrame:RegisterEvent("TRAIT_CONFIG_UPDATED")
  eventFrame:SetScript("OnEvent", function()
    if activeComparisonData then DrawComplianceOverlay() end
  end)
  if PlayerSpellsFrame then
    hooksecurefunc(PlayerSpellsFrame, "Show", function()
      if activeComparisonData then C_Timer.After(0.15, DrawComplianceOverlay) end
    end)
    if PlayerSpellsFrame.TalentsFrame then
      PlayerSpellsFrame.TalentsFrame:HookScript("OnShow", function()
        if activeComparisonData then C_Timer.After(0.15, DrawComplianceOverlay) end
      end)
    end
  end
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

-- ── Content roster ───────────────────────────────────────────────────────────
-- Mirrors scripts/export-meta-builds.js's boss/dungeon lists. Bundled so the panel
-- can show the FULL expected raid/dungeon list even where no data exists yet
-- (rather than silently only showing whatever happened to have enough parses) —
-- the earlier flat-list design made 2 populated bosses look like "the whole list,"
-- when really it was 2-of-10 with the rest just missing.

local RAID_BOSSES = {
  "Rotmire", "Imperator Averzian", "Vorasius", "Fallen-King Salhadaar",
  "Vaelgor & Ezzorak", "Lightblinded Vanguard", "Crown of the Cosmos",
  "Chimaerus, the Undreamt God", "Belo'ren, Child of Al'ar", "Midnight Falls",
}
local DUNGEON_NAMES = {
  "Windrunner Spire", "Maisara Caverns", "Nexus-Point Xenas", "Algeth'ar Academy",
  "Magisters' Terrace", "Pit of Saron", "Seat of the Triumvirate", "Skyreach",
}

-- ── Main panel ───────────────────────────────────────────────────────────────

local CARD_WIDTH = 410

local frame = CreateFrame("Frame", "HotsBBTalentsFrame", UIParent, "BasicFrameTemplateWithInset")
frame:SetSize(460, 520)
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
frame.title:SetText("HotsBB Talents")
do
  local _, classToken = UnitClass("player")
  if RAID_CLASS_COLORS and classToken and RAID_CLASS_COLORS[classToken] then
    local c = RAID_CLASS_COLORS[classToken]
    frame.title:SetTextColor(c.r, c.g, c.b)
  end
end

frame.clearOverlayBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
frame.clearOverlayBtn:SetSize(95, 18)
frame.clearOverlayBtn:SetPoint("TOPRIGHT", -34, -3)
frame.clearOverlayBtn:SetText("Clear Overlay")
frame.clearOverlayBtn:SetScript("OnClick", function()
  activeComparisonData = nil
  ClearComplianceOverlay()
end)

frame.subtitle = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
frame.subtitle:SetPoint("TOPLEFT", 16, -28)
frame.subtitle:SetPoint("RIGHT", -16, 0)
frame.subtitle:SetJustifyH("LEFT")
frame.subtitle:SetText("")

-- Tabs: which content type is browsed. Plain buttons with Disable() marking the
-- active one, rather than Blizzard's PanelTabButtonTemplate — that template's
-- exact helper functions (PanelTemplates_SetTab etc.) weren't worth depending on
-- unverified when a simple, guaranteed-correct pattern does the same job.
local activeTabKey = "raid"
local tabRaidBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
tabRaidBtn:SetSize(90, 22)
tabRaidBtn:SetPoint("TOPLEFT", 16, -50)
tabRaidBtn:SetText("Raid")

local tabDungeonBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
tabDungeonBtn:SetSize(90, 22)
tabDungeonBtn:SetPoint("LEFT", tabRaidBtn, "RIGHT", 6, 0)
tabDungeonBtn:SetText("Dungeons")

local scrollFrame = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
scrollFrame:SetPoint("TOPLEFT", 14, -78)
scrollFrame:SetPoint("BOTTOMRIGHT", -32, 14)

local content = CreateFrame("Frame", nil, scrollFrame)
content:SetSize(1, 1)
scrollFrame:SetScrollChild(content)

-- ── Card rendering ───────────────────────────────────────────────────────────
-- One card per boss/dungeon (not per hero-tree variant — that's what made the old
-- flat list unmanageable at raid/season scale). Multiple hero-tree builds for the
-- same encounter are pill-selectable within the card instead of separate rows.

local function RefreshCardButtons(card, variants)
  local variant = variants[card.selectedVariantIndex or 1]
  if not variant then return end
  local label = card.bossName
  if variant.heroTreeName and variant.heroTreeName ~= "Overall" then
    label = label .. " — " .. variant.heroTreeName
  end
  local importString = variant.importString
  card.importBtn:SetScript("OnClick", function() ImportBuild(importString, label) end)
  card.copyBtn:SetScript("OnClick", function() ShowCopyBox(importString) end)
  card.compareBtn:SetScript("OnClick", function()
    SetComparisonBuild(variant.frequencyPct or {}, variant.entryIds or {}, label)
  end)
  for i, pill in ipairs(card.pills) do
    if pill:IsShown() then
      if i == (card.selectedVariantIndex or 1) then pill:Disable() else pill:Enable() end
    end
  end
end

local cardPool = {}
local function GetCard(index)
  local card = cardPool[index]
  if card then return card end
  card = CreateFrame("Frame", nil, content, "BackdropTemplate")
  card:SetSize(CARD_WIDTH, 34)
  card:SetBackdrop({
    bgFile = "Interface\\Buttons\\WHITE8x8",
    edgeFile = "Interface\\Buttons\\WHITE8x8",
    edgeSize = 1,
  })
  card:SetBackdropColor(1, 1, 1, 0.07)
  card:SetBackdropBorderColor(1, 1, 1, 0.28)

  card.header = card:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  card.header:SetPoint("TOPLEFT", 10, -8)
  card.header:SetJustifyH("LEFT")

  card.badge = card:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  card.badge:SetPoint("TOPRIGHT", -10, -9)
  card.badge:SetJustifyH("RIGHT")

  card.pills = {}
  for i = 1, 4 do
    local pill = CreateFrame("Button", nil, card, "UIPanelButtonTemplate")
    pill:SetSize(90, 18)
    card.pills[i] = pill
  end

  card.importBtn = CreateFrame("Button", nil, card, "UIPanelButtonTemplate")
  card.importBtn:SetSize(60, 20)
  card.importBtn:SetText("Import")

  card.copyBtn = CreateFrame("Button", nil, card, "UIPanelButtonTemplate")
  card.copyBtn:SetSize(50, 20)
  card.copyBtn:SetText("Copy")

  card.compareBtn = CreateFrame("Button", nil, card, "UIPanelButtonTemplate")
  card.compareBtn:SetSize(65, 20)
  card.compareBtn:SetText("Compare")

  cardPool[index] = card
  return card
end

-- Populates a pooled card and returns the height it should occupy.
local function PopulateCard(card, bossName, variants)
  card.bossName = bossName
  card.header:SetText(bossName)
  for _, pill in ipairs(card.pills) do pill:Hide() end

  if not variants or #variants == 0 then
    card.badge:SetText("No data yet")
    card.importBtn:Hide()
    card.copyBtn:Hide()
    card.compareBtn:Hide()
    card:SetHeight(34)
    return 34
  end

  card.badge:SetText((variants[1].sampleSize or 0) .. " parses")

  local selectedIndex = card.selectedVariantIndex or 1
  if selectedIndex > #variants then selectedIndex = 1 end
  card.selectedVariantIndex = selectedIndex

  local hasPills = #variants > 1
  local buttonRowY = -30

  if hasPills then
    local x = 10
    for i, variant in ipairs(variants) do
      local pill = card.pills[i]
      if pill then
        pill:ClearAllPoints()
        pill:SetPoint("TOPLEFT", x, -30)
        pill:SetText(variant.heroTreeName or "Overall")
        local textWidth = pill:GetFontString() and pill:GetFontString():GetStringWidth() or 40
        pill:SetWidth(math.max(60, textWidth + 20))
        pill:SetScript("OnClick", function()
          card.selectedVariantIndex = i
          RefreshCardButtons(card, variants)
        end)
        pill:Show()
        x = x + pill:GetWidth() + 4
      end
    end
    buttonRowY = -54
  end

  card.importBtn:ClearAllPoints()
  card.importBtn:SetPoint("TOPRIGHT", -10, buttonRowY)
  card.copyBtn:ClearAllPoints()
  card.copyBtn:SetPoint("RIGHT", card.importBtn, "LEFT", -4, 0)
  card.compareBtn:ClearAllPoints()
  card.compareBtn:SetPoint("RIGHT", card.copyBtn, "LEFT", -4, 0)
  card.importBtn:Show()
  card.copyBtn:Show()
  card.compareBtn:Show()

  RefreshCardButtons(card, variants)

  local totalHeight = hasPills and 78 or 54
  card:SetHeight(totalHeight)
  return totalHeight
end

local function Refresh()
  local specID = GetCurrentSpecID()
  if not specID then
    frame.subtitle:SetText("Could not detect your current specialization.")
    for _, card in ipairs(cardPool) do card:Hide() end
    return
  end

  local specData = HotsBBTalentsData and HotsBBTalentsData[specID]
  local roster = activeTabKey == "raid" and RAID_BOSSES or DUNGEON_NAMES

  local haveCount = 0
  for _, name in ipairs(roster) do
    if specData and specData[name] then haveCount = haveCount + 1 end
  end
  local tabLabel = activeTabKey == "raid" and "Raid" or "Dungeons"
  frame.subtitle:SetText(tabLabel .. ": " .. haveCount .. " of " .. #roster ..
    " have data. Import decodes client-side; Copy always works as a fallback.")

  for _, card in ipairs(cardPool) do card:Hide() end

  local y = 0
  local cardIndex = 0
  for _, name in ipairs(roster) do
    cardIndex = cardIndex + 1
    local card = GetCard(cardIndex)
    card:ClearAllPoints()
    card:SetPoint("TOPLEFT", content, "TOPLEFT", 0, -y)
    card:SetPoint("RIGHT", content, "RIGHT", 0, 0)

    local bossEntry = specData and specData[name]
    local h = PopulateCard(card, name, bossEntry and bossEntry.variants)
    card:Show()
    y = y + h + 6
  end

  content:SetSize(CARD_WIDTH, math.max(y, 1))
end

local function SetActiveTab(key)
  activeTabKey = key
  if key == "raid" then
    tabRaidBtn:Disable()
    tabDungeonBtn:Enable()
  else
    tabDungeonBtn:Disable()
    tabRaidBtn:Enable()
  end
  Refresh()
end
tabRaidBtn:SetScript("OnClick", function() SetActiveTab("raid") end)
tabDungeonBtn:SetScript("OnClick", function() SetActiveTab("dungeon") end)
tabRaidBtn:Disable() -- raid tab active by default

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
