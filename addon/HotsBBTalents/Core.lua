-- HotsBB Talents — import/copy meta talent builds per boss/dungeon for your current spec.
--
-- Import decodes the loadout string client-side into real entries before calling
-- C_ClassTalents.ImportLoadout — a faithful Lua port of Blizzard's own decode logic
-- (ClassTalentImportExportMixin in Blizzard_ClassTalentImportExport.lua), since that
-- mixin isn't exposed for addons to call directly. Confirmed working in-game.
-- Copy remains available as a guaranteed-safe fallback that doesn't depend on any
-- of this decode logic — paste into the built-in Talents > Import dialog by hand.

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

-- Shared by both import paths: distributes a total rank count across a Tiered node's
-- sub-entries in the client's own canonical entryIDs order, capping each at that
-- entry's real maxRanks (queried live via C_Traits, not guessed). Tiered nodes (e.g.
-- Priest's Benediction, Warrior's Tigereye Brew) store each rank as a SEPARATE
-- TraitNodeEntry rather than one entry with a rank counter — ImportLoadout needs one
-- results row per sub-entry actually invested in, in the right order, or it silently
-- drops the ones it can't place.
local function BuildTieredNodeEntries(results, configID, treeNodeInfo, totalRanksPurchased, isNodeGranted)
  local remainingRanks = totalRanksPurchased
  for index, entryID in ipairs(treeNodeInfo.entryIDs) do
    local entryInfo = C_Traits.GetEntryInfo(configID, entryID)
    if entryInfo then
      local ranksForThisEntry = math.min(remainingRanks, entryInfo.maxRanks)
      local isGranted = isNodeGranted and (index == 1)
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

local function CreateEntryFromTieredNode(results, configID, treeNodeInfo, indexInfo)
  if not treeNodeInfo or not indexInfo or not indexInfo.isNodeSelected then return end

  local totalRanksPurchased = 0
  if not indexInfo.isNodeGranted then
    totalRanksPurchased = indexInfo.isPartiallyRanked and indexInfo.partialRanksPurchased or treeNodeInfo.maxRanks
  end

  BuildTieredNodeEntries(results, configID, treeNodeInfo, totalRanksPurchased, indexInfo.isNodeGranted)
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

-- wclEntries is built server-side from WCL telemetry, which reports Tiered nodes
-- (Benediction, Tigereye Brew, etc.) as one row per sub-entry actually taken but with
-- no reliable way to know this client's canonical entryIDs order or each sub-entry's
-- real maxRanks — so a naive "1 rank per row, in whatever order WCL gave them" guess
-- can hand ImportLoadout entries it can't place, silently dropping picks (reported:
-- apex nodes missing 2 of their talents on import). Fix: for any nodeID that this
-- live client reports as Tiered, discard the guessed rows and rebuild them properly
-- via BuildTieredNodeEntries, driven only by the total rank WCL observed.
--
-- Non-Tiered nodes have a separate staleness problem: WCL telemetry is a permanent
-- historical record, so a row's selectionEntryID reflects whatever was valid when
-- that fight happened — even after a later Blizzard hotfix regenerates a node's entry
-- IDs without changing the tree's visual layout (confirmed live: this exact thing
-- happened mid-season). The server already drops choice nodes whose ID no longer
-- matches either current option rather than risk applying the wrong one, but an
-- ordinary single-option node's stale ID previously passed straight through — and
-- ImportLoadout silently drops any entry it can't place, so it would just vanish from
-- the imported build (reported: "sometimes it doesn't copy the talents over").
-- Every row is now checked against this client's own live entryIDs for that node: a
-- single-option node has no ambiguity, so a mismatch is safely corrected to the one
-- real option; a genuinely multi-option node that still doesn't match is dropped
-- rather than guessed at, same as the server-side rule for choice nodes.
local function ResolveWclEntries(configID, rawEntries)
  local order, byNode = {}, {}
  for _, e in ipairs(rawEntries) do
    if not byNode[e.nodeID] then
      byNode[e.nodeID] = {}
      table.insert(order, e.nodeID)
    end
    table.insert(byNode[e.nodeID], e)
  end

  local results = {}
  for _, nodeID in ipairs(order) do
    local rows = byNode[nodeID]
    local treeNodeInfo = C_Traits.GetNodeInfo(configID, nodeID)
    if treeNodeInfo and treeNodeInfo.type == Enum.TraitNodeType.Tiered and treeNodeInfo.entryIDs and #treeNodeInfo.entryIDs > 0 then
      local totalRanksPurchased, isNodeGranted = 0, false
      for _, row in ipairs(rows) do
        totalRanksPurchased = totalRanksPurchased + (row.ranksPurchased or 0) + (row.ranksGranted or 0)
        if (row.ranksGranted or 0) > 0 then isNodeGranted = true end
      end
      BuildTieredNodeEntries(results, configID, treeNodeInfo, totalRanksPurchased, isNodeGranted)
    else
      for _, row in ipairs(rows) do
        local resolvedRow = row
        if treeNodeInfo and treeNodeInfo.entryIDs and #treeNodeInfo.entryIDs > 0 then
          local isValid = false
          for _, validID in ipairs(treeNodeInfo.entryIDs) do
            if validID == row.selectionEntryID then
              isValid = true
              break
            end
          end
          if not isValid then
            if #treeNodeInfo.entryIDs == 1 then
              resolvedRow = {
                nodeID = row.nodeID,
                ranksGranted = row.ranksGranted,
                ranksPurchased = row.ranksPurchased,
                selectionEntryID = treeNodeInfo.entryIDs[1],
              }
            else
              resolvedRow = nil
            end
          end
        end
        if resolvedRow then
          table.insert(results, resolvedRow)
        end
      end
    end
  end
  return results
end

-- wclEntries rows are built server-side in whatever order WCL's CombatantInfo happened
-- to report each node — unrelated to the tree's actual parent/child structure. The
-- Blizzard-string decode path (ConvertToImportLoadoutEntryInfo, "confirmed working")
-- always emits entries via C_Traits.GetTreeNodes' order, which is a valid dependency
-- order (a node's prerequisites always precede it). If ImportLoadout processes its
-- entries array sequentially and needs a node's prerequisite already applied before
-- it'll accept that node, an out-of-order entries array can silently drop nodes deep
-- in the tree — reported: the final (deepest/capstone) node missing on import even
-- though Copy, which always uses tree order, has it. Cheap and safe to always do: sort
-- wclEntries into the same canonical order before importing. Stable (ties broken by
-- original position) so BuildTieredNodeEntries' per-node entry ordering survives intact.
local function SortEntriesByTreeOrder(entries, treeID)
  local treeNodes = C_Traits.GetTreeNodes(treeID)
  local orderIndex = {}
  for i, nodeID in ipairs(treeNodes) do orderIndex[nodeID] = i end

  local indexed = {}
  for i, entry in ipairs(entries) do
    indexed[i] = { entry = entry, order = orderIndex[entry.nodeID] or math.huge, orig = i }
  end
  table.sort(indexed, function(a, b)
    if a.order ~= b.order then return a.order < b.order end
    return a.orig < b.orig
  end)

  local sorted = {}
  for i, item in ipairs(indexed) do sorted[i] = item.entry end
  return sorted
end

-- Prefers wclEntries (built server-side straight from WCL telemetry — no Blizzard
-- character-profile dependency, so it's available for every player regardless of
-- region) when present, skipping the string encode/decode round-trip entirely. Falls
-- back to decoding importString (the older path, Blizzard-profile-derived) when
-- wclEntries isn't there — e.g. a spec/boss combo where no player's WCL data resolved
-- cleanly enough to build entries from.
local function ImportBuild(variant, displayName)
  if not variant or (not variant.wclEntries and not variant.importString) then
    Announce("|cffff4444HotsBB Talents:|r No import data for this build.", 1.0, 0.3, 0.3)
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

  local entries, decodeErr
  if variant.wclEntries then
    if not (C_Traits and C_Traits.GetNodeInfo and C_Traits.GetEntryInfo and C_Traits.GetConfigInfo and C_Traits.GetTreeNodes) then
      Announce("|cffff4444HotsBB Talents:|r C_Traits API not found on this client. Use Copy instead.", 1.0, 0.3, 0.3)
      return false
    end
    entries = ResolveWclEntries(configID, variant.wclEntries)
    local configInfo = C_Traits.GetConfigInfo(configID)
    local treeID = configInfo and configInfo.treeIDs and configInfo.treeIDs[1]
    if treeID then
      entries = SortEntriesByTreeOrder(entries, treeID)
    end
  else
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
    entries, decodeErr = DecodeLoadoutString(variant.importString, configID, treeID)
    if not entries then
      Announce("|cffff4444HotsBB Talents:|r Decode failed: " .. tostring(decodeErr) .. ". Use Copy instead.", 1.0, 0.3, 0.3)
      return false
    end
  end

  local ok, success, importError = pcall(C_ClassTalents.ImportLoadout, configID, entries, displayName or "HotsBB Meta Build", variant.importString)
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

-- ── Design system ────────────────────────────────────────────────────────────
-- Everything below is drawn from scratch — no Blizzard frame/button templates
-- (BasicFrameTemplateWithInset, UIPanelButtonTemplate, tooltip borders, etc.).
-- Every visual piece is a plain colored texture (SetColorTexture) or a font
-- string, so there's zero dependency on guessing atlas/texture names — nothing
-- here can be "wrong" the way an unverified atlas reference could be.

local COLOR_BG           = { 0.045, 0.045, 0.055 }
local COLOR_TITLEBAR     = { 0.02, 0.02, 0.03 }
local COLOR_PANEL        = { 0.10, 0.10, 0.12 }
local COLOR_PANEL_HOVER  = { 0.13, 0.13, 0.16 }
local COLOR_DIVIDER      = { 1, 1, 1 }
local COLOR_TEXT         = { 0.94, 0.94, 0.96 }
local COLOR_TEXT_MUTED   = { 0.52, 0.52, 0.57 }
local COLOR_BTN          = { 0.15, 0.15, 0.18 }
local COLOR_BTN_HOVER    = { 0.20, 0.20, 0.24 }
local COLOR_GOLD         = { 1, 0.82, 0 }

local COLOR_ACCENT = { 0.55, 0.55, 0.62 }
do
  local _, classToken = UnitClass("player")
  if RAID_CLASS_COLORS and classToken and RAID_CLASS_COLORS[classToken] then
    local c = RAID_CLASS_COLORS[classToken]
    COLOR_ACCENT = { c.r, c.g, c.b }
  end
end

local function Paint(tex, color, alpha)
  tex:SetColorTexture(color[1], color[2], color[3], alpha == nil and 1 or alpha)
end

local function CreatePanel(parent, name)
  local f = CreateFrame("Frame", name, parent)
  f.bg = f:CreateTexture(nil, "BACKGROUND")
  f.bg:SetAllPoints()
  return f
end

-- Thin 1px divider line, used instead of a beveled border.
local function CreateDivider(parent, alpha)
  local tex = parent:CreateTexture(nil, "ARTWORK")
  Paint(tex, COLOR_DIVIDER, alpha or 0.08)
  return tex
end

-- variant: "primary" (accent fill, dark text), "flat" (subtle dark fill), "ghost" (transparent, text-only)
local function CreateFlatButton(parent, text, variant, w, h)
  local btn = CreateFrame("Button", nil, parent)
  btn:SetSize(w or 60, h or 24)
  btn.bg = btn:CreateTexture(nil, "BACKGROUND")
  btn.bg:SetAllPoints()

  btn.label = btn:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  btn.label:SetPoint("CENTER")
  btn.label:SetText(text)

  local function ApplyIdle()
    if variant == "primary" then
      Paint(btn.bg, COLOR_ACCENT, 0.9)
      btn.label:SetTextColor(0.05, 0.05, 0.05)
    elseif variant == "ghost" then
      Paint(btn.bg, COLOR_TEXT, 0)
      btn.label:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])
    else
      Paint(btn.bg, COLOR_BTN)
      btn.label:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])
    end
  end
  local function ApplyHover()
    if variant == "primary" then
      Paint(btn.bg, COLOR_ACCENT, 1)
    elseif variant == "ghost" then
      Paint(btn.bg, COLOR_TEXT, 0.08)
      btn.label:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])
    else
      Paint(btn.bg, COLOR_BTN_HOVER)
    end
  end
  ApplyIdle()
  btn:SetScript("OnEnter", ApplyHover)
  btn:SetScript("OnLeave", ApplyIdle)
  return btn
end

-- Toggle button for tabs/pills: persistent selected state (accent underline/fill)
-- rather than hover-only feedback.
local function CreateToggleButton(parent, text, w, h)
  local btn = CreateFrame("Button", nil, parent)
  btn:SetSize(w or 80, h or 24)
  btn.bg = btn:CreateTexture(nil, "BACKGROUND")
  btn.bg:SetAllPoints()
  Paint(btn.bg, COLOR_TEXT, 0)

  btn.underline = btn:CreateTexture(nil, "ARTWORK")
  btn.underline:SetPoint("BOTTOMLEFT", 0, 0)
  btn.underline:SetPoint("BOTTOMRIGHT", 0, 0)
  btn.underline:SetHeight(2)
  Paint(btn.underline, COLOR_ACCENT, 0)

  btn.label = btn:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  btn.label:SetPoint("CENTER")
  btn.label:SetText(text)
  btn.label:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])

  function btn:SetSelected(selected)
    self.selected = selected
    if selected then
      Paint(self.underline, COLOR_ACCENT, 1)
      self.label:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])
    else
      Paint(self.underline, COLOR_ACCENT, 0)
      self.label:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])
    end
  end
  btn:SetScript("OnEnter", function(self) if not self.selected then Paint(self.bg, COLOR_TEXT, 0.05) end end)
  btn:SetScript("OnLeave", function(self) Paint(self.bg, COLOR_TEXT, 0) end)
  return btn
end

-- ── Copy-string popup (guaranteed-safe fallback: no addon API dependency) ────

local copyFrame = CreatePanel(UIParent, "HotsBBTalentsCopyFrame")
copyFrame:SetSize(420, 130)
copyFrame:SetPoint("CENTER")
copyFrame:SetFrameStrata("DIALOG")
copyFrame:SetMovable(true)
copyFrame:EnableMouse(true)
copyFrame:RegisterForDrag("LeftButton")
copyFrame:SetScript("OnDragStart", copyFrame.StartMoving)
copyFrame:SetScript("OnDragStop", copyFrame.StopMovingOrSizing)
copyFrame:Hide()
Paint(copyFrame.bg, COLOR_PANEL, 0.98)
tinsert(UISpecialFrames, "HotsBBTalentsCopyFrame")

local copyTitleBar = CreatePanel(copyFrame)
copyTitleBar:SetPoint("TOPLEFT")
copyTitleBar:SetPoint("TOPRIGHT")
copyTitleBar:SetHeight(30)
Paint(copyTitleBar.bg, COLOR_TITLEBAR)

copyFrame.title = copyTitleBar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
copyFrame.title:SetPoint("LEFT", 12, 0)
copyFrame.title:SetText("Copy build string")
copyFrame.title:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])

local copyCloseBtn = CreateFlatButton(copyTitleBar, "x", "ghost", 26, 22)
copyCloseBtn:SetPoint("RIGHT", -4, 0)
copyCloseBtn:SetScript("OnClick", function() copyFrame:Hide() end)

local copyHint = copyFrame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
copyHint:SetPoint("TOPLEFT", 14, -38)
copyHint:SetText("Ctrl+C, then paste into Talents > Import")
copyHint:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])

local copyBoxBg = CreatePanel(copyFrame)
copyBoxBg:SetPoint("TOPLEFT", 14, -58)
copyBoxBg:SetPoint("TOPRIGHT", -14, -58)
copyBoxBg:SetHeight(26)
Paint(copyBoxBg.bg, COLOR_TITLEBAR)

local copyBox = CreateFrame("EditBox", nil, copyBoxBg)
copyBox:SetPoint("TOPLEFT", 6, 0)
copyBox:SetPoint("BOTTOMRIGHT", -6, 0)
copyBox:SetAutoFocus(false)
copyBox:SetFontObject(GameFontNormalSmall)
copyBox:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])
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

local CARD_WIDTH = 430

local frame = CreatePanel(UIParent, "HotsBBTalentsFrame")
frame:SetSize(480, 560)
frame:SetPoint("CENTER")
frame:SetFrameStrata("HIGH")
frame:SetMovable(true)
frame:EnableMouse(true)
frame:RegisterForDrag("LeftButton")
frame:SetScript("OnDragStart", frame.StartMoving)
frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
frame:Hide()
Paint(frame.bg, COLOR_BG, 0.98)
tinsert(UISpecialFrames, "HotsBBTalentsFrame") -- lets Esc close it like a default Blizzard panel

-- Thin accent-colored strip along the very top edge — a small "branded" touch.
local accentStrip = frame:CreateTexture(nil, "ARTWORK")
accentStrip:SetPoint("TOPLEFT")
accentStrip:SetPoint("TOPRIGHT")
accentStrip:SetHeight(3)
Paint(accentStrip, COLOR_ACCENT, 0.9)

local titleBar = CreatePanel(frame)
titleBar:SetPoint("TOPLEFT", 0, -3)
titleBar:SetPoint("TOPRIGHT", 0, -3)
titleBar:SetHeight(40)
Paint(titleBar.bg, COLOR_TITLEBAR)
titleBar:EnableMouse(true)
titleBar:RegisterForDrag("LeftButton")
titleBar:SetScript("OnDragStart", function() frame:StartMoving() end)
titleBar:SetScript("OnDragStop", function() frame:StopMovingOrSizing() end)

-- Class + spec icons come straight from the client (no network fetch at all): class
-- icons via the standard CLASS_ICON_TCOORDS atlas every addon uses for this, spec icon
-- via GetSpecializationInfo's 4th return value, which is a ready-to-use texture fileID.
frame.classIcon = titleBar:CreateTexture(nil, "ARTWORK")
frame.classIcon:SetSize(18, 18)
frame.classIcon:SetPoint("LEFT", 14, 0)
do
  local _, classToken = UnitClass("player")
  if classToken and CLASS_ICON_TCOORDS and CLASS_ICON_TCOORDS[classToken] then
    frame.classIcon:SetTexture("Interface\\TargetingFrame\\UI-Classes-Circles")
    local coords = CLASS_ICON_TCOORDS[classToken]
    frame.classIcon:SetTexCoord(coords[1], coords[2], coords[3], coords[4])
  end
end

frame.specIcon = titleBar:CreateTexture(nil, "ARTWORK")
frame.specIcon:SetSize(18, 18)
frame.specIcon:SetPoint("LEFT", frame.classIcon, "RIGHT", 5, 0)
do
  local specIndex = GetSpecialization and GetSpecialization()
  if specIndex then
    local _, _, _, icon = GetSpecializationInfo(specIndex)
    if icon then frame.specIcon:SetTexture(icon) end
  end
end

frame.title = titleBar:CreateFontString(nil, "OVERLAY", "GameFontNormal")
frame.title:SetPoint("LEFT", frame.specIcon, "RIGHT", 8, 0)
frame.title:SetText("HotsBB Talents")
frame.title:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])

-- Small "what am I looking at" explainer — a hover tooltip rather than a permanent
-- line of text, so it doesn't compete with the layout for space.
local infoBtn = CreateFlatButton(titleBar, "i", "ghost", 18, 18)
infoBtn:SetPoint("LEFT", frame.title, "RIGHT", 6, 1)
infoBtn.label:SetFont(select(1, infoBtn.label:GetFont()), 11, "OUTLINE")
-- Hook rather than SetScript — CreateFlatButton already wired OnEnter/OnLeave for the
-- hover-highlight visual, and hooking chains onto that instead of replacing it.
infoBtn:HookScript("OnEnter", function(self)
  GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
  GameTooltip:SetText("What builds are these?", 1, 1, 1)
  GameTooltip:AddLine("The most common talent build among top parses on Warcraft Logs for this class/spec, boss (or dungeon), and difficulty. The % on each pill shows how many of those parses picked that hero tree.", COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3], true)
  GameTooltip:Show()
end)
infoBtn:HookScript("OnLeave", function() GameTooltip:Hide() end)

local closeBtn = CreateFlatButton(titleBar, "x", "ghost", 30, 26)
closeBtn:SetPoint("RIGHT", -6, 0)
closeBtn:SetScript("OnClick", function() frame:Hide() end)

frame.subtitle = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
frame.subtitle:SetPoint("TOPLEFT", 16, -50)
frame.subtitle:SetPoint("RIGHT", -16, 0)
frame.subtitle:SetJustifyH("LEFT")
frame.subtitle:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])
frame.subtitle:SetText("")

-- Tabs: which content type is browsed. Underline-indicator toggle buttons.
local activeTabKey = "raid"
local tabRaidBtn = CreateToggleButton(frame, "Raid", 70, 26)
tabRaidBtn:SetPoint("TOPLEFT", 12, -70)

local tabDungeonBtn = CreateToggleButton(frame, "Dungeons", 90, 26)
tabDungeonBtn:SetPoint("LEFT", tabRaidBtn, "RIGHT", 4, 0)

local tabDivider = CreateDivider(frame)
tabDivider:SetPoint("TOPLEFT", 0, -96)
tabDivider:SetPoint("TOPRIGHT", 0, -96)
tabDivider:SetHeight(1)

local scrollFrame = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
scrollFrame:SetPoint("TOPLEFT", 14, -104)
scrollFrame:SetPoint("BOTTOMRIGHT", -30, 16)

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
  card.importBtn:SetScript("OnClick", function() ImportBuild(variant, label) end)
  card.copyBtn:SetScript("OnClick", function() ShowCopyBox(importString) end)
  for i, pill in ipairs(card.pills) do
    if pill:IsShown() then
      pill:SetSelected(i == (card.selectedVariantIndex or 1))
    end
  end
end

local cardPool = {}
local function GetCard(index)
  local card = cardPool[index]
  if card then return card end
  card = CreatePanel(content)
  card:SetSize(CARD_WIDTH, 40)
  Paint(card.bg, COLOR_PANEL)
  card:EnableMouse(true)
  card:SetScript("OnEnter", function(self) if not self.highlighted then Paint(self.bg, COLOR_PANEL_HOVER) end end)
  card:SetScript("OnLeave", function(self) if not self.highlighted then Paint(self.bg, COLOR_PANEL) end end)

  -- Left accent bar, hidden by default — shown gold when this is the auto-detected
  -- "you are here" card.
  card.accentBar = card:CreateTexture(nil, "ARTWORK")
  card.accentBar:SetPoint("TOPLEFT")
  card.accentBar:SetPoint("BOTTOMLEFT")
  card.accentBar:SetWidth(3)
  Paint(card.accentBar, COLOR_GOLD, 0)

  card.header = card:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  card.header:SetPoint("TOPLEFT", 14, -10)
  card.header:SetJustifyH("LEFT")
  card.header:SetTextColor(COLOR_TEXT[1], COLOR_TEXT[2], COLOR_TEXT[3])

  card.badge = card:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  card.badge:SetPoint("TOPRIGHT", -12, -11)
  card.badge:SetJustifyH("RIGHT")
  card.badge:SetTextColor(COLOR_TEXT_MUTED[1], COLOR_TEXT_MUTED[2], COLOR_TEXT_MUTED[3])

  card.pills = {}
  for i = 1, 4 do
    local pill = CreateToggleButton(card, "", 90, 20)
    card.pills[i] = pill
  end

  card.importBtn = CreateFlatButton(card, "Import", "primary", 64, 22)
  card.copyBtn = CreateFlatButton(card, "Copy", "flat", 54, 22)

  cardPool[index] = card
  return card
end

-- Populates a pooled card and returns the height it should occupy.
local function PopulateCard(card, bossName, variants)
  card.bossName = bossName
  card.header:SetText(bossName)
  card.highlighted = false
  Paint(card.accentBar, COLOR_GOLD, 0)
  Paint(card.bg, COLOR_PANEL)
  for _, pill in ipairs(card.pills) do pill:Hide() end

  if not variants or #variants == 0 then
    card.badge:SetText("No data yet")
    card.importBtn:Hide()
    card.copyBtn:Hide()
    card:SetHeight(40)
    return 40
  end

  card.badge:SetText((variants[1].sampleSize or 0) .. " parses")

  local selectedIndex = card.selectedVariantIndex or 1
  if selectedIndex > #variants then selectedIndex = 1 end
  card.selectedVariantIndex = selectedIndex

  local hasPills = #variants > 1
  local buttonRowY = -34

  if hasPills then
    local x = 14
    -- Denominator is the sum of *categorized* parses (those attributed to a specific
    -- hero tree), not the overall sample — some parses never get a hero tree detected,
    -- and dividing by the full total would make even a unanimous pick look like a
    -- minority choice (e.g. the only listed tree reading "30%" instead of "100%").
    local categorizedTotal = 0
    for j = 2, #variants do
      categorizedTotal = categorizedTotal + (variants[j].sampleSize or 0)
    end
    for i, variant in ipairs(variants) do
      local pill = card.pills[i]
      if pill then
        pill:ClearAllPoints()
        pill:SetPoint("TOPLEFT", x, -36)
        local label = variant.heroTreeName or "Overall"
        -- "Overall" is the blended baseline across every hero tree, so its own take
        -- rate is trivially 100% and not worth showing. Real hero-tree variants get
        -- their share of the categorized sample so it's obvious which build dominates.
        if variant.heroTreeName and variant.heroTreeName ~= "Overall" and categorizedTotal > 0 then
          local pct = math.floor(((variant.sampleSize or 0) / categorizedTotal) * 100 + 0.5)
          label = label .. "  " .. pct .. "%"
        end
        pill.label:SetText(label)
        local textWidth = pill.label:GetStringWidth() or 40
        pill:SetWidth(math.max(64, textWidth + 24))
        pill:SetScript("OnClick", function()
          card.selectedVariantIndex = i
          RefreshCardButtons(card, variants)
        end)
        pill:Show()
        x = x + pill:GetWidth() + 6
      end
    end
    buttonRowY = -62
  end

  card.importBtn:ClearAllPoints()
  card.importBtn:SetPoint("TOPRIGHT", -12, buttonRowY)
  card.copyBtn:ClearAllPoints()
  card.copyBtn:SetPoint("RIGHT", card.importBtn, "LEFT", -6, 0)
  card.importBtn:Show()
  card.copyBtn:Show()

  RefreshCardButtons(card, variants)

  local totalHeight = hasPills and 88 or 62
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
    card.topOffset = y

    local bossEntry = specData and specData[name]
    local h = PopulateCard(card, name, bossEntry and bossEntry.variants)
    card:Show()
    y = y + h + 8
  end

  content:SetSize(CARD_WIDTH, math.max(y, 1))
end

local function SetActiveTab(key)
  activeTabKey = key
  tabRaidBtn:SetSelected(key == "raid")
  tabDungeonBtn:SetSelected(key == "dungeon")
  Refresh()
end
tabRaidBtn:SetScript("OnClick", function() SetActiveTab("raid") end)
tabDungeonBtn:SetScript("OnClick", function() SetActiveTab("dungeon") end)
tabRaidBtn:SetSelected(true) -- raid tab active by default

-- ── Auto-jump to current zone ────────────────────────────────────────────────
-- GetInstanceInfo() is a local client call, no network/data dependency. For dungeons
-- the instance name matches our roster names directly, so we can jump straight to
-- that card. For raids the zone name doesn't map to one specific boss, so we can only
-- select the right tab — still saves a click over always defaulting to Raid.
local function DetectCurrentZoneMatch()
  local name, instanceType = GetInstanceInfo()
  if not name or name == "" then return nil, nil end
  if instanceType == "party" then
    for _, dname in ipairs(DUNGEON_NAMES) do
      if dname == name then return "dungeon", dname end
    end
    return "dungeon", nil
  elseif instanceType == "raid" then
    return "raid", nil
  end
  return nil, nil
end

frame:SetScript("OnShow", function()
  local tabKey, matchedName = DetectCurrentZoneMatch()
  if tabKey then
    activeTabKey = tabKey
    tabRaidBtn:SetSelected(tabKey == "raid")
    tabDungeonBtn:SetSelected(tabKey == "dungeon")
  end

  Refresh()

  if matchedName then
    for _, card in ipairs(cardPool) do
      if card.bossName == matchedName and card:IsShown() then
        scrollFrame:SetVerticalScroll(card.topOffset or 0)
        card.highlighted = true
        Paint(card.accentBar, COLOR_GOLD, 1)
        Paint(card.bg, COLOR_PANEL_HOVER)
        break
      end
    end
  end
end)

-- ── Slash command & AddOn Compartment ────────────────────────────────────────
-- Modern WoW replaced classic draggable minimap buttons with the AddOn Compartment
-- (the small icon near the minimap that expands into a dropdown of addons), so no
-- minimap-button library or custom art asset is needed — just register into it.

local function ToggleFrame()
  if frame:IsShown() then
    frame:Hide()
  else
    frame:Show()
  end
end

SLASH_HOTSBBTALENTS1 = "/hbt"
SLASH_HOTSBBTALENTS2 = "/hotsbbtalents"
SlashCmdList["HOTSBBTALENTS"] = ToggleFrame

if C_AddOns and C_AddOns.RegisterAddOnCompartmentInfo then
  C_AddOns.RegisterAddOnCompartmentInfo({
    text = "HotsBB Talents",
    icon = "Interface\\Icons\\INV_Misc_Book_09",
    notCheckable = true,
    func = ToggleFrame,
  })
end

-- ── Button on Blizzard's own Talents screen ──────────────────────────────────
-- Frame names/structure here can vary by patch (see EnsureTalentFrameLoaded above,
-- which hit the same uncertainty) — this is written defensively and may need
-- adjusting once actually seen in-game. PlayerSpellsFrame is the modern combined
-- Spellbook+Talents frame; ClassTalentFrame is the older standalone one, kept as a
-- fallback. If a dedicated Talents sub-frame can be identified, the button is tied
-- to its own show/hide so it only appears on the Talents tab specifically; otherwise
-- it falls back to showing whenever the host frame is open at all.
local talentScreenButtonAdded = false
local function AddTalentScreenButton()
  if talentScreenButtonAdded then return end

  local host = PlayerSpellsFrame or ClassTalentFrame
  if not host then return end
  talentScreenButtonAdded = true

  -- "flat" instead of "primary" — the solid class-colored fill read as loud/out of
  -- place next to Raider.IO's subdued dark pill. Smaller and slimmer too, to sit
  -- alongside it rather than dominate the corner.
  local btn = CreateFlatButton(UIParent, "HotsBB Talents", "flat", 200, 20)
  btn:SetFrameStrata("HIGH")
  btn:Hide()
  btn:SetScript("OnClick", ToggleFrame)
  btn.label:SetFont(select(1, btn.label:GetFont()), 10)

  -- A thin class-colored underline for a touch of brand identity without the loud fill.
  local accentLine = btn:CreateTexture(nil, "ARTWORK")
  accentLine:SetPoint("BOTTOMLEFT", 2, 1)
  accentLine:SetPoint("BOTTOMRIGHT", -2, 1)
  accentLine:SetHeight(2)
  Paint(accentLine, COLOR_ACCENT, 0.9)

  -- Try to find the specific Talents tab so the button doesn't also show on the
  -- Spellbook tab; fall back to the whole host frame if none of these exist.
  local talentsSubFrame = host.TalentsFrame or host.TalentsTab or host.ClassTalentFrame
  local showTarget = talentsSubFrame or host

  -- The "Default Loadout" dropdown is a native Blizzard element (unlike Raider.IO's
  -- button, whose frame name is unknowable), so it's worth trying to anchor directly
  -- to it for real center alignment that holds up regardless of UI scale — far more
  -- reliable than a guessed pixel offset, if the field name resolves. This is safe to
  -- attempt even if wrong: an unresolved guess is just nil, and falls through to the
  -- fixed-offset fallback rather than erroring.
  local loadoutDropdown = (talentsSubFrame and (talentsSubFrame.LoadoutDropDown or talentsSubFrame.LoadoutSelector))
    or host.LoadoutDropDown or host.LoadoutSelector

  if loadoutDropdown then
    btn:SetPoint("BOTTOM", loadoutDropdown, "TOP", 0, 58)
  else
    -- Confirmed via screenshot: the dropdown guess above doesn't resolve on this game
    -- version, so this fallback is what's actually rendering. The dropdown, Raider.IO's
    -- button, and our button all share the same left edge — so instead of guessing a
    -- shifted offset (tried and it undershot), matching our button's *width* to the
    -- dropdown's width achieves the same center alignment geometrically: same left edge
    -- + same width = same center, without needing to guess a shift amount.
    btn:SetPoint("BOTTOMLEFT", showTarget, "BOTTOMLEFT", 15, 95)
  end
  showTarget:HookScript("OnShow", function() btn:Show() end)
  showTarget:HookScript("OnHide", function() btn:Hide() end)
  if showTarget:IsShown() then btn:Show() end
end

local talentScreenWatcher = CreateFrame("Frame")
talentScreenWatcher:RegisterEvent("PLAYER_LOGIN")
talentScreenWatcher:RegisterEvent("ADDON_LOADED")
talentScreenWatcher:SetScript("OnEvent", function(_, event, addonName)
  if event == "ADDON_LOADED" and addonName ~= "Blizzard_PlayerSpells" and addonName ~= "Blizzard_ClassTalentUI" then
    return
  end
  AddTalentScreenButton()
  if talentScreenButtonAdded then talentScreenWatcher:UnregisterAllEvents() end
end)
