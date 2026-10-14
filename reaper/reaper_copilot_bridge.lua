-- REAPER Copilot bridge
-- Carica questo script in REAPER (Actions > New action > Load ReaScript...) e lancialo.
-- Resta in esecuzione in background e scambia comandi JSON con il server Node
-- tramite la cartella "ipc" accanto allo script.

local VERSION = "0.3.1"

---------------------------------------------------------------------------
-- Paths
---------------------------------------------------------------------------
local SEP = package.config:sub(1, 1)
local script_path = debug.getinfo(1, "S").source:match("@?(.*[\\/])") or ("." .. SEP)
local IPC_DIR = script_path .. "ipc" .. SEP
local RENDER_DIR = script_path .. "renders" .. SEP

---------------------------------------------------------------------------
-- Minimal JSON
---------------------------------------------------------------------------
local json = {}

local escapes = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encode_string(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    return escapes[c] or string.format("\\u%04x", c:byte())
  end) .. '"'
end

local function is_array(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or math.floor(k) ~= k then return false end
    n = n + 1
  end
  for i = 1, n do if t[i] == nil then return false end end
  return true, n
end

function json.encode(v)
  local tv = type(v)
  if v == nil then return "null"
  elseif tv == "boolean" then return v and "true" or "false"
  elseif tv == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.floor(v) == v and math.abs(v) < 1e15 then return string.format("%d", v) end
    return string.format("%.6g", v)
  elseif tv == "string" then return encode_string(v)
  elseif tv == "table" then
    local arr, n = is_array(v)
    local out = {}
    if arr then
      for i = 1, n do out[i] = json.encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    for k, val in pairs(v) do
      out[#out + 1] = encode_string(tostring(k)) .. ":" .. json.encode(val)
    end
    return "{" .. table.concat(out, ",") .. "}"
  end
  return "null"
end

local function utf8_char(cp)
  if cp < 0x80 then return string.char(cp)
  elseif cp < 0x800 then return string.char(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
  elseif cp < 0x10000 then
    return string.char(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
  end
  return string.char(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
end

function json.decode(str)
  local pos = 1
  local function ws() pos = str:find("[^ \t\r\n]", pos) or (#str + 1) end
  local function err(m) error("JSON: " .. m .. " at " .. pos) end
  local value

  local function str_val()
    pos = pos + 1
    local buf = {}
    while true do
      local c = str:sub(pos, pos)
      if c == "" then err("unterminated string") end
      if c == '"' then pos = pos + 1; break end
      if c == "\\" then
        local e = str:sub(pos + 1, pos + 1)
        local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
        if map[e] then buf[#buf + 1] = map[e]; pos = pos + 2
        elseif e == "u" then
          local cp = tonumber(str:sub(pos + 2, pos + 5), 16) or err("bad \\u")
          pos = pos + 6
          if cp >= 0xD800 and cp <= 0xDBFF and str:sub(pos, pos + 1) == "\\u" then
            local lo = tonumber(str:sub(pos + 2, pos + 5), 16)
            if lo and lo >= 0xDC00 and lo <= 0xDFFF then
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
              pos = pos + 6
            end
          end
          buf[#buf + 1] = utf8_char(cp)
        else err("bad escape") end
      else
        local s, e = str:find('[^"\\]+', pos)
        buf[#buf + 1] = str:sub(s, e)
        pos = e + 1
      end
    end
    return table.concat(buf)
  end

  function value()
    ws()
    local c = str:sub(pos, pos)
    if c == "{" then
      pos = pos + 1
      local obj = {}
      ws()
      if str:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        ws()
        if str:sub(pos, pos) ~= '"' then err("expected key") end
        local k = str_val()
        ws()
        if str:sub(pos, pos) ~= ":" then err("expected :") end
        pos = pos + 1
        obj[k] = value()
        ws()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
        if d ~= "," then err("expected , or }") end
      end
    elseif c == "[" then
      pos = pos + 1
      local arr = {}
      ws()
      if str:sub(pos, pos) == "]" then pos = pos + 1; return arr end
      while true do
        arr[#arr + 1] = value()
        ws()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return arr end
        if d ~= "," then err("expected , or ]") end
      end
    elseif c == '"' then return str_val()
    elseif str:sub(pos, pos + 3) == "true" then pos = pos + 4; return true
    elseif str:sub(pos, pos + 4) == "false" then pos = pos + 5; return false
    elseif str:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil
    else
      local s, e = str:find("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
      if not s then err("unexpected char '" .. c .. "'") end
      pos = e + 1
      return tonumber(str:sub(s, e))
    end
  end

  return value()
end

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------
local function db_to_amp(db) return 10 ^ (db / 20) end
local function amp_to_db(a)
  if a <= 0.0000000298023223876953125 then return -150 end
  return 20 * math.log(a, 10)
end
local function round(x, d)
  local m = 10 ^ (d or 2)
  return math.floor(x * m + 0.5) / m
end

local function track_name(tr)
  if tr == reaper.GetMasterTrack(0) then return "MASTER" end
  local _, name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  return name
end

local function track_index(tr)
  if tr == reaper.GetMasterTrack(0) then return -1 end
  return math.floor(reaper.GetMediaTrackInfo_Value(tr, "IP_TRACKNUMBER")) - 1
end

local function get_track(ref)
  if ref == nil then error("parametro 'track' mancante") end
  if ref == "master" or ref == "MASTER" or ref == -1 then return reaper.GetMasterTrack(0) end
  if type(ref) == "number" then
    local tr = reaper.GetTrack(0, math.floor(ref))
    if not tr then error("traccia " .. ref .. " inesistente") end
    return tr
  end
  local want = tostring(ref):lower()
  if want == "master" then return reaper.GetMasterTrack(0) end
  local n = reaper.CountTracks(0)
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    if track_name(tr):lower() == want then return tr end
  end
  if tonumber(want) then return get_track(tonumber(want)) end
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    if track_name(tr):lower():find(want, 1, true) then return tr end
  end
  error("traccia '" .. tostring(ref) .. "' non trovata")
end

local function fx_name(tr, i)
  local _, name = reaper.TrackFX_GetFXName(tr, i, "")
  return name
end

local function get_fx(tr, ref)
  if ref == nil then error("parametro 'fx' mancante") end
  local count = reaper.TrackFX_GetCount(tr)
  if type(ref) == "number" then
    if ref < 0 or ref >= count then error("fx " .. ref .. " inesistente (la traccia ha " .. count .. " fx)") end
    return math.floor(ref)
  end
  local want = tostring(ref):lower()
  for i = 0, count - 1 do
    if fx_name(tr, i):lower() == want then return i end
  end
  if tonumber(want) then return get_fx(tr, tonumber(want)) end
  for i = 0, count - 1 do
    if fx_name(tr, i):lower():find(want, 1, true) then return i end
  end
  error("fx '" .. tostring(ref) .. "' non trovato sulla traccia " .. track_name(tr))
end

local function param_name(tr, fx, p)
  local _, name = reaper.TrackFX_GetParamName(tr, fx, p, "")
  return name
end

local function get_param(tr, fx, ref)
  local n = reaper.TrackFX_GetNumParams(tr, fx)
  if type(ref) == "number" then
    if ref < 0 or ref >= n then error("parametro " .. ref .. " inesistente") end
    return math.floor(ref)
  end
  local want = tostring(ref):lower()
  for p = 0, n - 1 do
    if param_name(tr, fx, p):lower() == want then return p end
  end
  if tonumber(want) then return get_param(tr, fx, tonumber(want)) end
  for p = 0, n - 1 do
    if param_name(tr, fx, p):lower():find(want, 1, true) then return p end
  end
  error("parametro '" .. tostring(ref) .. "' non trovato")
end

local function formatted(tr, fx, p)
  local _, s = reaper.TrackFX_GetFormattedParamValue(tr, fx, p, "")
  return s
end

local function parse_num(s)
  if not s then return nil end
  if s:lower():find("%-inf") then return -1e9 end
  if s:lower():find("^%s*inf") or s:lower():find("^%s*%+inf") then return 1e9 end
  local n, suffix = s:match("([%-%+]?%d*%.?%d+)%s*([kK]?)")
  n = tonumber(n)
  if n and suffix ~= "" then n = n * 1000 end
  return n
end

-- Imposta un parametro cercando il valore normalizzato che produce il valore
-- visualizzato richiesto (es. 120 per "120 Hz", -3 per "-3.0 dB").
-- Trova il valore normalizzato (0..1) che produce il valore visualizzato richiesto
-- (es. 120 per "120 Hz", -3 per "-3.0 dB"). Non lascia modifiche al parametro.
local function find_norm_for_display(tr, fx, p, target)
  local original = reaper.TrackFX_GetParamNormalized(tr, fx, p)
  local touched = false
  local function probe(x)
    local ok, s = reaper.TrackFX_FormatParamValueNormalized(tr, fx, p, x, "")
    if not ok or s == "" then
      touched = true
      reaper.TrackFX_SetParamNormalized(tr, fx, p, x)
      s = formatted(tr, fx, p)
    end
    return parse_num(s)
  end
  local v0, v1 = probe(0), probe(1)
  if v0 == nil or v1 == nil then error("il parametro " .. param_name(tr, fx, p) .. " non ha un valore numerico") end
  local increasing = v1 >= v0
  local lo, hi = 0.0, 1.0
  for _ = 1, 40 do
    local mid = (lo + hi) / 2
    local v = probe(mid)
    if v == nil then break end
    if (v < target) == increasing then lo = mid else hi = mid end
  end
  local vlo, vhi = probe(lo), probe(hi)
  local best = (math.abs((vlo or 1e12) - target) <= math.abs((vhi or 1e12) - target)) and lo or hi
  if touched then reaper.TrackFX_SetParamNormalized(tr, fx, p, original) end
  return best
end

-- ricerca "vera": imposta il parametro e rilegge il valore visualizzato (più lenta ma affidabile)
local function search_by_setting(tr, fx, p, target)
  local function probe(x)
    reaper.TrackFX_SetParamNormalized(tr, fx, p, x)
    return parse_num(formatted(tr, fx, p))
  end
  local v0, v1 = probe(0), probe(1)
  if v0 == nil or v1 == nil then error("il parametro " .. param_name(tr, fx, p) .. " non ha un valore numerico") end
  local increasing = v1 >= v0
  local lo, hi = 0.0, 1.0
  for _ = 1, 40 do
    local mid = (lo + hi) / 2
    local v = probe(mid)
    if v == nil then break end
    if (v < target) == increasing then lo = mid else hi = mid end
  end
  local vlo, vhi = probe(lo), probe(hi)
  return (math.abs((vlo or 1e12) - target) <= math.abs((vhi or 1e12) - target)) and lo or hi
end

local function close_enough(v, target)
  return v ~= nil and math.abs(v - target) <= math.max(0.05 * math.abs(target), 0.1)
end

local function set_param_by_display(tr, fx, p, target)
  local best = find_norm_for_display(tr, fx, p, target)
  reaper.TrackFX_SetParamNormalized(tr, fx, p, best)
  -- alcuni plugin/versioni formattano in modo inaffidabile i valori ipotetici: verifico
  if not close_enough(parse_num(formatted(tr, fx, p)), target) then
    best = search_by_setting(tr, fx, p, target)
    reaper.TrackFX_SetParamNormalized(tr, fx, p, best)
  end
  return best
end

local function track_info(tr, with_fx)
  local info = {
    index = track_index(tr),
    name = track_name(tr),
    volume_db = round(amp_to_db(reaper.GetMediaTrackInfo_Value(tr, "D_VOL")), 2),
    pan = round(reaper.GetMediaTrackInfo_Value(tr, "D_PAN"), 3),
    mute = reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") == 1,
  }
  if info.index >= 0 then
    info.solo = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO") > 0
    info.phase_inverted = reaper.GetMediaTrackInfo_Value(tr, "B_PHASE") == 1
    info.folder_depth = math.floor(reaper.GetMediaTrackInfo_Value(tr, "I_FOLDERDEPTH"))
    info.items = reaper.CountTrackMediaItems(tr)
    info.selected = reaper.IsTrackSelected(tr)
    info.main_send = reaper.GetMediaTrackInfo_Value(tr, "B_MAINSEND") == 1
    local parent = reaper.GetParentTrack(tr)
    if parent then info.parent = track_index(parent) end
    local sends = {}
    for s = 0, reaper.GetTrackNumSends(tr, 0) - 1 do
      local dest = reaper.GetTrackSendInfo_Value(tr, 0, s, "P_DESTTRACK")
      sends[#sends + 1] = {
        dest = dest and track_index(dest) or nil,
        volume_db = round(amp_to_db(reaper.GetTrackSendInfo_Value(tr, 0, s, "D_VOL")), 2),
      }
    end
    if #sends > 0 then info.sends = sends end
  end
  if with_fx then
    local fxs = {}
    for i = 0, reaper.TrackFX_GetCount(tr) - 1 do
      fxs[#fxs + 1] = { index = i, name = fx_name(tr, i), enabled = reaper.TrackFX_GetEnabled(tr, i) }
    end
    info.fx = fxs
  end
  return info
end

local function refresh()
  reaper.TrackList_AdjustWindows(false)
  reaper.UpdateArrange()
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------
local RENDER_NUM_KEYS = {
  "RENDER_SETTINGS", "RENDER_BOUNDSFLAG", "RENDER_STARTPOS", "RENDER_ENDPOS",
  "RENDER_SRATE", "RENDER_CHANNELS", "RENDER_ADDTOPROJ", "RENDER_NORMALIZE", "RENDER_TAILFLAG",
}
local RENDER_STR_KEYS = { "RENDER_FILE", "RENDER_PATTERN", "RENDER_FORMAT" }

local function file_exists(path)
  local f = io.open(path, "rb")
  if f then f:close(); return true end
  return false
end

local function render(args)
  local target = args.target or "master"
  local name = args.name or ("render_" .. os.time())
  local dir = args.out_dir or RENDER_DIR
  if dir:sub(-1) ~= "/" and dir:sub(-1) ~= "\\" then dir = dir .. SEP end
  reaper.RecursiveCreateDirectory(dir, 0)

  local saved_num, saved_str = {}, {}
  for _, k in ipairs(RENDER_NUM_KEYS) do saved_num[k] = reaper.GetSetProjectInfo(0, k, 0, false) end
  for _, k in ipairs(RENDER_STR_KEYS) do
    local _, v = reaper.GetSetProjectInfo_String(0, k, "", false)
    saved_str[k] = v
  end

  -- solo delle tracce richieste (solo-in-place); "targets" = più tracce insieme (es. tutta la batteria)
  local saved_solo = {}
  local warn
  local solo_list = {}
  if type(args.targets) == "table" and #args.targets > 0 then
    for _, t in ipairs(args.targets) do solo_list[#solo_list + 1] = get_track(t) end
  elseif target ~= "master" and target ~= -1 and target ~= "MASTER" then
    solo_list[1] = get_track(target)
  end
  local solo_target = #solo_list > 0 or nil
  if solo_target then
    for _, tr in ipairs(solo_list) do
      if reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") == 1 then warn = "traccia in mute: " .. track_name(tr) end
    end
    for i = 0, reaper.CountTracks(0) - 1 do
      local tr = reaper.GetTrack(0, i)
      saved_solo[i] = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO")
      reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", 0)
    end
    for _, tr in ipairs(solo_list) do reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", 2) end
  end

  local bounds = args.bounds or "project"
  local bflag = 1
  if bounds == "time_selection" then bflag = 2
  elseif type(bounds) == "table" then
    bflag = 0
    reaper.GetSetProjectInfo(0, "RENDER_STARTPOS", bounds.start or 0, true)
    reaper.GetSetProjectInfo(0, "RENDER_ENDPOS", bounds["end"] or reaper.GetProjectLength(0), true)
  end

  reaper.GetSetProjectInfo_String(0, "RENDER_FILE", dir, true)
  reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", name, true)
  reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "evaw", true)
  reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true)
  reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", bflag, true)
  reaper.GetSetProjectInfo(0, "RENDER_SRATE", args.sample_rate or 44100, true)
  reaper.GetSetProjectInfo(0, "RENDER_CHANNELS", 2, true)
  reaper.GetSetProjectInfo(0, "RENDER_ADDTOPROJ", 0, true)
  reaper.GetSetProjectInfo(0, "RENDER_NORMALIZE", 0, true)
  reaper.GetSetProjectInfo(0, "RENDER_TAILFLAG", 0, true)

  local ok, e = pcall(reaper.Main_OnCommand, 42230, 0) -- Render project, most recent settings, auto-close

  -- ripristino
  for k, v in pairs(saved_num) do reaper.GetSetProjectInfo(0, k, v, true) end
  for k, v in pairs(saved_str) do reaper.GetSetProjectInfo_String(0, k, v, true) end
  if solo_target then
    for i, v in pairs(saved_solo) do
      local tr = reaper.GetTrack(0, i)
      if tr then reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", v) end
    end
  end
  refresh()
  if not ok then error("render fallito: " .. tostring(e)) end

  local path = dir .. name .. ".wav"
  if not file_exists(path) then error("render completato ma file non trovato: " .. path) end
  return { path = path, warning = warn }
end

---------------------------------------------------------------------------
-- Commands
---------------------------------------------------------------------------
local C = {}
local MUTATING = {}

function C.ping()
  local _, proj_name = reaper.GetProjectName(0, "")
  return { bridge = VERSION, reaper = reaper.GetAppVersion(), project = proj_name }
end

function C.get_project(args)
  local _, proj_name = reaper.GetProjectName(0, "")
  local ts_start, ts_end = reaper.GetSet_LoopTimeRange(false, false, 0, 0, false)
  local tracks = {}
  for i = 0, reaper.CountTracks(0) - 1 do
    tracks[#tracks + 1] = track_info(reaper.GetTrack(0, i), true)
  end
  local num, den = reaper.TimeMap_GetTimeSigAtTime(0, 0)
  return {
    project = proj_name,
    tempo = reaper.Master_GetTempo(),
    time_signature = num and (num .. "/" .. den) or nil,
    length_sec = round(reaper.GetProjectLength(0), 2),
    time_selection = (ts_end > ts_start) and { start = round(ts_start, 3), ["end"] = round(ts_end, 3) } or nil,
    cursor_sec = round(reaper.GetCursorPosition(), 3),
    master = track_info(reaper.GetMasterTrack(0), true),
    tracks = tracks,
  }
end

function C.get_fx_params(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  local filter = args.filter and tostring(args.filter):lower()
  local limit = args.limit or 150
  local params = {}
  local n = reaper.TrackFX_GetNumParams(tr, fx)
  for p = 0, n - 1 do
    local name = param_name(tr, fx, p)
    if not filter or name:lower():find(filter, 1, true) then
      params[#params + 1] = {
        index = p,
        name = name,
        value = round(reaper.TrackFX_GetParamNormalized(tr, fx, p), 4),
        display = formatted(tr, fx, p),
      }
      if #params >= limit then break end
    end
  end
  local _, preset = reaper.TrackFX_GetPreset(tr, fx, "")
  return {
    track = track_name(tr), fx_index = fx, fx = fx_name(tr, fx),
    enabled = reaper.TrackFX_GetEnabled(tr, fx), preset = preset,
    total_params = n, params = params,
  }
end

MUTATING.set_track = true
function C.set_track(args)
  local tr = get_track(args.track)
  if args.name ~= nil then reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", tostring(args.name), true) end
  if args.volume_db ~= nil then reaper.SetMediaTrackInfo_Value(tr, "D_VOL", db_to_amp(args.volume_db)) end
  if args.pan ~= nil then reaper.SetMediaTrackInfo_Value(tr, "D_PAN", math.max(-1, math.min(1, args.pan))) end
  if args.mute ~= nil then reaper.SetMediaTrackInfo_Value(tr, "B_MUTE", args.mute and 1 or 0) end
  if args.solo ~= nil then reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", args.solo and 2 or 0) end
  if args.phase_inverted ~= nil then reaper.SetMediaTrackInfo_Value(tr, "B_PHASE", args.phase_inverted and 1 or 0) end
  if args.main_send ~= nil then reaper.SetMediaTrackInfo_Value(tr, "B_MAINSEND", args.main_send and 1 or 0) end
  return track_info(tr, false)
end

MUTATING.create_track = true
function C.create_track(args)
  local idx = args.index or reaper.CountTracks(0)
  reaper.InsertTrackAtIndex(idx, true)
  local tr = reaper.GetTrack(0, idx)
  if args.name then reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", args.name, true) end
  return track_info(tr, false)
end

MUTATING.delete_track = true
function C.delete_track(args)
  local tr = get_track(args.track)
  if tr == reaper.GetMasterTrack(0) then error("non posso eliminare il master") end
  local name = track_name(tr)
  reaper.DeleteTrack(tr)
  return { deleted = name }
end

-- Elenco dei plugin installati. Con REAPER recenti uso EnumInstalledFX; altrimenti leggo
-- i JSFX dalle cartelle Effects (riga "desc:") e i VST dalle cache di REAPER.
local installed_cache = nil

local function read_head(path, bytes)
  local f = io.open(path, "rb")
  if not f then return nil end
  local s = f:read(bytes or 4096)
  f:close()
  return s
end

local SKIP_EXT = { png = 1, jpg = 1, txt = 1, ["jsfx-inc"] = 1, rpl = 1, dll = 1, ttf = 1, md = 1, ini = 1, wav = 1, html = 1, json = 1, lua = 1, eel = 1, py = 1 }

local function scan_jsfx(root, rel, out, depth)
  if depth > 5 or #out > 4000 then return end
  local dir = root .. (rel ~= "" and (SEP .. rel) or "")
  reaper.EnumerateFiles(dir, -1)
  local i = 0
  while true do
    local f = reaper.EnumerateFiles(dir, i)
    if not f then break end
    local ext = f:match("%.([^.]+)$")
    if not (ext and SKIP_EXT[ext:lower()]) then
      local head = read_head(dir .. SEP .. f, 4096)
      local desc = head and head:match("\ndesc:%s*([^\r\n]+)") or (head and head:match("^desc:%s*([^\r\n]+)"))
      if desc then
        local relpath = (rel ~= "" and (rel:gsub("\\", "/") .. "/") or "") .. f
        out[#out + 1] = { name = "JS: " .. desc, add = "JS:" .. relpath, path = relpath }
      end
    end
    i = i + 1
  end
  reaper.EnumerateSubdirectories(dir, -1)
  local j = 0
  while true do
    local d = reaper.EnumerateSubdirectories(dir, j)
    if not d then break end
    scan_jsfx(root, rel ~= "" and (rel .. SEP .. d) or d, out, depth + 1)
    j = j + 1
  end
end

local function scan_vst_ini(path, out)
  local f = io.open(path, "r")
  if not f then return end
  for line in f:lines() do
    local file, rest = line:match("^([^=]+)=(.+)$")
    if file and rest then
      local name = rest:match("^[^,]*,[^,]*,(.+)$")
      if name and name ~= "" and not name:find("^<SHELL>") then
        name = name:gsub("!!!VSTi", "")
        local prefix = file:lower():find("%.vst3$") and "VST3: " or "VST: "
        out[#out + 1] = { name = prefix .. name, add = name }
      end
    end
  end
  f:close()
end

local function installed_fx()
  if installed_cache then return installed_cache end
  local out = {}
  if reaper.EnumInstalledFX then
    local i = 0
    while true do
      local ok, name, ident = reaper.EnumInstalledFX(i)
      if not ok then break end
      out[#out + 1] = { name = name, add = name }
      i = i + 1
    end
  else
    local res = reaper.GetResourcePath()
    scan_jsfx(res .. SEP .. "Effects", "", out, 0)
    if reaper.GetExePath then scan_jsfx(reaper.GetExePath() .. SEP .. "InstallData" .. SEP .. "Effects", "", out, 0) end
    scan_vst_ini(res .. SEP .. "reaper-vstplugins64.ini", out)
    scan_vst_ini(res .. SEP .. "reaper-vstplugins.ini", out)
  end
  -- tolgo i doppioni (stesso nome)
  local seen, uniq = {}, {}
  for _, e in ipairs(out) do
    if not seen[e.name] then seen[e.name] = true; uniq[#uniq + 1] = e end
  end
  installed_cache = uniq
  return uniq
end

local function find_installed(query, limit)
  local q = tostring(query or ""):lower():gsub("^%a+%d?:%s*", "")
  local exact, partial = {}, {}
  for _, e in ipairs(installed_fx()) do
    local n = e.name:lower():gsub("^%a+%d?:%s*", "")
    if n == q or (e.path and e.path:lower() == q) then exact[#exact + 1] = e
    elseif q == "" or n:find(q, 1, true) or (e.path and e.path:lower():find(q, 1, true)) then partial[#partial + 1] = e end
    if #partial >= (limit or 200) then break end
  end
  for _, e in ipairs(partial) do exact[#exact + 1] = e end
  return exact
end

MUTATING.add_fx = true
local function add_fx_resolved(tr, name)
  name = tostring(name or "")
  local idx = reaper.TrackFX_AddByName(tr, name, false, -1)
  if idx < 0 then
    -- varianti del nome e ricerca tra i plugin installati
    local tries = { (name:gsub("^(%a+%d?):%s+", "%1:")), (name:gsub("^%a+%d?:%s*", "")) }
    for _, e in ipairs(find_installed(name, 20)) do tries[#tries + 1] = e.add end
    for _, t in ipairs(tries) do
      if t ~= "" and t ~= name then
        idx = reaper.TrackFX_AddByName(tr, t, false, -1)
        if idx >= 0 then break end
      end
    end
  end
  if idx < 0 then
    local similar = {}
    local word = name:lower():gsub("^%a+%d?:%s*", ""):match("%a+") or ""
    for _, e in ipairs(find_installed(word, 10)) do similar[#similar + 1] = e.name end
    error("plugin '" .. name .. "' non trovato." .. (#similar > 0 and (" Simili installati: " .. table.concat(similar, "; ")) or " Usa list_installed_fx per i nomi esatti"), 0)
  end
  return idx
end

function C.add_fx(args)
  local tr = get_track(args.track)
  local idx = add_fx_resolved(tr, args.fx_name)
  if args.position ~= nil and args.position ~= idx then
    reaper.TrackFX_CopyToTrack(tr, idx, tr, args.position, true)
    idx = args.position
  end
  if args.preset then reaper.TrackFX_SetPreset(tr, idx, args.preset) end
  return { track = track_name(tr), fx_index = idx, fx = fx_name(tr, idx), num_params = reaper.TrackFX_GetNumParams(tr, idx) }
end

MUTATING.remove_fx = true
function C.remove_fx(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  local name = fx_name(tr, fx)
  reaper.TrackFX_Delete(tr, fx)
  return { removed = name }
end

MUTATING.set_fx_enabled = true
function C.set_fx_enabled(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  reaper.TrackFX_SetEnabled(tr, fx, args.enabled ~= false)
  return { fx = fx_name(tr, fx), enabled = reaper.TrackFX_GetEnabled(tr, fx) }
end

MUTATING.set_fx_params = true
function C.set_fx_params(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  local results = {}
  for _, item in ipairs(args.params or {}) do
    local ok, res = pcall(function()
      local p = get_param(tr, fx, item.param)
      if item.display ~= nil then
        set_param_by_display(tr, fx, p, tonumber(item.display))
      elseif item.value ~= nil then
        reaper.TrackFX_SetParamNormalized(tr, fx, p, math.max(0, math.min(1, item.value)))
      else
        error("specifica 'value' (0-1) o 'display'")
      end
      return { param = param_name(tr, fx, p), index = p, display = formatted(tr, fx, p),
               value = round(reaper.TrackFX_GetParamNormalized(tr, fx, p), 4) }
    end)
    results[#results + 1] = ok and res or { param = item.param, error = tostring(res) }
  end
  return { fx = fx_name(tr, fx), results = results }
end

function C.get_fx_named_config(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  local out = {}
  for _, key in ipairs(args.keys or {}) do
    local ok, v = reaper.TrackFX_GetNamedConfigParm(tr, fx, key)
    out[key] = ok and v or nil
  end
  return out
end

MUTATING.set_fx_named_config = true
function C.set_fx_named_config(args)
  local tr = get_track(args.track)
  local fx = get_fx(tr, args.fx)
  local ok = reaper.TrackFX_SetNamedConfigParm(tr, fx, args.key, tostring(args.value))
  return { ok = ok }
end

MUTATING.add_send = true
function C.add_send(args)
  local src = get_track(args.src)
  local dst = get_track(args.dst)
  local idx = reaper.CreateTrackSend(src, dst)
  if idx < 0 then error("impossibile creare il send") end
  if args.volume_db ~= nil then reaper.SetTrackSendInfo_Value(src, 0, idx, "D_VOL", db_to_amp(args.volume_db)) end
  if args.pre_fader then reaper.SetTrackSendInfo_Value(src, 0, idx, "I_SENDMODE", 3) end
  return { src = track_name(src), dst = track_name(dst), send_index = idx }
end

MUTATING.set_send = true
function C.set_send(args)
  local src = get_track(args.src)
  local idx = math.floor(args.send_index or 0)
  if args.volume_db ~= nil then reaper.SetTrackSendInfo_Value(src, 0, idx, "D_VOL", db_to_amp(args.volume_db)) end
  if args.mute ~= nil then reaper.SetTrackSendInfo_Value(src, 0, idx, "B_MUTE", args.mute and 1 or 0) end
  return { ok = true }
end

function C.set_time_selection(args)
  reaper.GetSet_LoopTimeRange(true, false, args.start or 0, args["end"] or 0, false)
  return { ok = true }
end

function C.render(args) return render(args) end

function C.list_installed_fx(args)
  local out = {}
  for _, e in ipairs(find_installed(args.filter, args.limit or 200)) do out[#out + 1] = e.name end
  return { fx = out, source = reaper.EnumInstalledFX and "EnumInstalledFX" or "scansione cartelle" }
end

MUTATING.undo = false
function C.undo()
  reaper.Main_OnCommand(40029, 0)
  return { ok = true, undone = reaper.Undo_CanRedo2(0) }
end

MUTATING.run_action = true
function C.run_action(args)
  local id = args.id
  if type(id) == "string" and tonumber(id) then id = tonumber(id) end
  if type(id) == "string" then id = reaper.NamedCommandLookup(id) end
  if not id or id == 0 then error("azione non trovata") end
  reaper.Main_OnCommand(id, 0)
  return { ok = true }
end

MUTATING.run_lua = true
function C.run_lua(args)
  local output = {}
  local env = setmetatable({
    print = function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
      output[#output + 1] = table.concat(parts, "\t")
    end,
  }, { __index = _G })
  local chunk, cerr = load(args.code, "copilot", "t", env)
  if not chunk then error("errore di sintassi: " .. tostring(cerr)) end
  local ret = chunk()
  return { output = table.concat(output, "\n"), result = ret }
end


---------------------------------------------------------------------------
-- Piano di mix: tante modifiche in un solo comando (e un solo undo)
---------------------------------------------------------------------------
local function clean_err(e)
  return (tostring(e):gsub("^[^\n]-:%d+: ", ""))
end

local function norm_fx_name(n)
  n = tostring(n or ""):lower()
  n = n:gsub("^%a+%d?i?:%s*", ""):gsub("%s*%b()%s*$", ""):gsub("^%s+", ""):gsub("%s+$", "")
  return n
end

local function fx_matches(actual, wanted)
  local a, w = norm_fx_name(actual), norm_fx_name(wanted)
  if w == "" then return false end
  return a == w or a:find(w, 1, true) ~= nil or w:find(a, 1, true) ~= nil
end

local function apply_params(tr, idx, params)
  local set = {}
  for pname, v in pairs(params or {}) do
    local ok, err = pcall(function()
      local p = get_param(tr, idx, pname)
      if type(v) == "table" then
        reaper.TrackFX_SetParamNormalized(tr, idx, p, math.max(0, math.min(1, tonumber(v.value) or 0)))
      elseif type(v) == "boolean" then
        reaper.TrackFX_SetParamNormalized(tr, idx, p, v and 1 or 0)
      else
        local num = tonumber(v)
        if num == nil then error("valore non numerico: " .. tostring(v), 0) end
        set_param_by_display(tr, idx, p, num)
      end
      set[param_name(tr, idx, p)] = formatted(tr, idx, p)
    end)
    if not ok then set[tostring(pname)] = "ERRORE: " .. clean_err(err) end
  end
  return set
end

MUTATING.apply_plan = true
function C.apply_plan(args)
  local entries = {}
  for _, e in ipairs(args.tracks or {}) do entries[#entries + 1] = e end
  if type(args.master) == "table" then
    args.master.track = "master"
    entries[#entries + 1] = args.master
  end
  local report = {}
  for _, e in ipairs(entries) do
    local r = { track = tostring(e.track) }
    local ok, err = pcall(function()
      local tr = get_track(e.track)
      r.track = track_name(tr)
      if e.volume_db ~= nil then reaper.SetMediaTrackInfo_Value(tr, "D_VOL", db_to_amp(tonumber(e.volume_db))) end
      if e.pan ~= nil then reaper.SetMediaTrackInfo_Value(tr, "D_PAN", math.max(-1, math.min(1, tonumber(e.pan)))) end
      if e.mute ~= nil then reaper.SetMediaTrackInfo_Value(tr, "B_MUTE", e.mute and 1 or 0) end
      for _, rem in ipairs(e.remove_fx or {}) do
        local okr, fx = pcall(get_fx, tr, rem)
        if okr then reaper.TrackFX_Delete(tr, fx) end
      end
      local used = {}
      r.fx = {}
      for _, f in ipairs(e.fx or {}) do
        local fr = { name = f.name }
        local okf, errf = pcall(function()
          local idx
          if f.index ~= nil then
            idx = math.floor(tonumber(f.index))
            if idx < 0 or idx >= reaper.TrackFX_GetCount(tr) then error("fx " .. idx .. " inesistente", 0) end
          else
            -- riuso il plugin se c'è già (niente doppioni a ogni giro), altrimenti lo aggiungo
            for i = 0, reaper.TrackFX_GetCount(tr) - 1 do
              if not used[i] and fx_matches(fx_name(tr, i), f.name) then idx = i; break end
            end
          end
          if idx == nil then
            idx = add_fx_resolved(tr, f.name)
            fr.added = true
          end
          used[idx] = true
          if f.enabled ~= nil then reaper.TrackFX_SetEnabled(tr, idx, f.enabled and true or false) end
          fr.fx = fx_name(tr, idx)
          fr.index = idx
          fr.params = apply_params(tr, idx, f.params)
        end)
        if not okf then fr.error = clean_err(errf) end
        r.fx[#r.fx + 1] = fr
      end
      r.volume_db = round(amp_to_db(reaper.GetMediaTrackInfo_Value(tr, "D_VOL")), 2)
    end)
    if not ok then r.error = clean_err(err) end
    report[#report + 1] = r
  end
  return { applied = report }
end

---------------------------------------------------------------------------
-- Item (le parti audio sulla timeline)
---------------------------------------------------------------------------
local function item_info(tr, i, it)
  local take = reaper.GetActiveTake(it)
  local info = {
    index = i,
    position = round(reaper.GetMediaItemInfo_Value(it, "D_POSITION"), 3),
    length = round(reaper.GetMediaItemInfo_Value(it, "D_LENGTH"), 3),
    volume_db = round(amp_to_db(reaper.GetMediaItemInfo_Value(it, "D_VOL")), 2),
    fade_in = round(reaper.GetMediaItemInfo_Value(it, "D_FADEINLEN"), 3),
    fade_out = round(reaper.GetMediaItemInfo_Value(it, "D_FADEOUTLEN"), 3),
    mute = reaper.GetMediaItemInfo_Value(it, "B_MUTE") == 1,
    takes = reaper.CountTakes(it),
  }
  info["end"] = round(info.position + info.length, 3)
  if take then
    local _, tname = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
    info.take = tname
    info.take_volume_db = round(amp_to_db(math.abs(reaper.GetMediaItemTakeInfo_Value(take, "D_VOL"))), 2)
    info.pitch = reaper.GetMediaItemTakeInfo_Value(take, "D_PITCH")
    info.playrate = reaper.GetMediaItemTakeInfo_Value(take, "D_PLAYRATE")
    info.midi = reaper.TakeIsMIDI(take)
  end
  return info
end

-- item per indice sulla traccia, oppure quello che contiene il tempo "at" (secondi)
local function get_item(tr, args)
  local n = reaper.CountTrackMediaItems(tr)
  if args.item ~= nil then
    local i = math.floor(tonumber(args.item) or -1)
    local it = reaper.GetTrackMediaItem(tr, i)
    if not it then error("item " .. tostring(args.item) .. " inesistente (la traccia ha " .. n .. " item)") end
    return it, i
  end
  if args.at ~= nil then
    for i = 0, n - 1 do
      local it = reaper.GetTrackMediaItem(tr, i)
      local pos = reaper.GetMediaItemInfo_Value(it, "D_POSITION")
      local len = reaper.GetMediaItemInfo_Value(it, "D_LENGTH")
      if args.at >= pos and args.at < pos + len then return it, i end
    end
    error("nessun item a " .. args.at .. "s sulla traccia " .. track_name(tr))
  end
  error("specifica 'item' (indice) oppure 'at' (secondi)")
end

function C.list_items(args)
  local tr = get_track(args.track)
  local out = {}
  local n = reaper.CountTrackMediaItems(tr)
  for i = 0, math.min(n, args.limit or 200) - 1 do
    out[#out + 1] = item_info(tr, i, reaper.GetTrackMediaItem(tr, i))
  end
  return { track = track_name(tr), count = n, items = out }
end

MUTATING.edit_item = true
function C.edit_item(args)
  local tr = get_track(args.track)
  local it, i = get_item(tr, args)
  local take = reaper.GetActiveTake(it)
  if args.volume_db ~= nil then reaper.SetMediaItemInfo_Value(it, "D_VOL", db_to_amp(args.volume_db)) end
  if args.fade_in ~= nil then reaper.SetMediaItemInfo_Value(it, "D_FADEINLEN", math.max(0, args.fade_in)) end
  if args.fade_out ~= nil then reaper.SetMediaItemInfo_Value(it, "D_FADEOUTLEN", math.max(0, args.fade_out)) end
  if args.fade_shape ~= nil then
    reaper.SetMediaItemInfo_Value(it, "C_FADEINSHAPE", args.fade_shape)
    reaper.SetMediaItemInfo_Value(it, "C_FADEOUTSHAPE", args.fade_shape)
  end
  if args.mute ~= nil then reaper.SetMediaItemInfo_Value(it, "B_MUTE", args.mute and 1 or 0) end
  if args.position ~= nil then reaper.SetMediaItemInfo_Value(it, "D_POSITION", math.max(0, args.position)) end
  if args.move_by ~= nil then
    local pos = reaper.GetMediaItemInfo_Value(it, "D_POSITION")
    reaper.SetMediaItemInfo_Value(it, "D_POSITION", math.max(0, pos + args.move_by))
  end
  if args.length ~= nil then reaper.SetMediaItemInfo_Value(it, "D_LENGTH", math.max(0.001, args.length)) end
  if args.trim_start ~= nil and args.trim_start ~= 0 then
    -- accorcia (positivo) o allunga (negativo) l'inizio senza spostare l'audio nel tempo
    local pos = reaper.GetMediaItemInfo_Value(it, "D_POSITION")
    local len = reaper.GetMediaItemInfo_Value(it, "D_LENGTH")
    local d = math.min(args.trim_start, len - 0.001)
    reaper.SetMediaItemInfo_Value(it, "D_POSITION", pos + d)
    reaper.SetMediaItemInfo_Value(it, "D_LENGTH", len - d)
    if take then
      local offs = reaper.GetMediaItemTakeInfo_Value(take, "D_STARTOFFS")
      local rate = reaper.GetMediaItemTakeInfo_Value(take, "D_PLAYRATE")
      reaper.SetMediaItemTakeInfo_Value(take, "D_STARTOFFS", math.max(0, offs + d * rate))
    end
  end
  if take then
    if args.pitch ~= nil then reaper.SetMediaItemTakeInfo_Value(take, "D_PITCH", args.pitch) end
    if args.playrate ~= nil then reaper.SetMediaItemTakeInfo_Value(take, "D_PLAYRATE", args.playrate) end
  end
  reaper.UpdateItemInProject(it)
  return item_info(tr, i, it)
end

MUTATING.split_item = true
function C.split_item(args)
  local tr = get_track(args.track)
  local times = args.times or { args.time }
  local done = {}
  table.sort(times, function(a, b) return a > b end) -- dal fondo, così gli indici restano validi
  for _, t in ipairs(times) do
    local ok = pcall(function()
      local it = get_item(tr, { at = t })
      if reaper.SplitMediaItem(it, t) then done[#done + 1] = t end
    end)
    if not ok then done[#done + 1] = { time = t, error = "nessun item a quel tempo" } end
  end
  return { track = track_name(tr), splits = done, items = reaper.CountTrackMediaItems(tr) }
end

MUTATING.delete_item = true
function C.delete_item(args)
  local tr = get_track(args.track)
  local it, i = get_item(tr, args)
  local info = item_info(tr, i, it)
  reaper.DeleteTrackMediaItem(tr, it)
  return { deleted = info }
end

---------------------------------------------------------------------------
-- Automazioni (envelope)
---------------------------------------------------------------------------
local function with_only_track_selected(tr, fn)
  local saved = {}
  for i = 0, reaper.CountSelectedTracks(0) - 1 do saved[#saved + 1] = reaper.GetSelectedTrack(0, i) end
  reaper.SetOnlyTrackSelected(tr)
  local ok, res = pcall(fn)
  reaper.SetOnlyTrackSelected(tr)
  reaper.SetTrackSelected(tr, false)
  for _, t in ipairs(saved) do reaper.SetTrackSelected(t, true) end
  if not ok then error(res, 0) end
  return res
end

-- ritorna envelope, kind ("volume" | "fx"), info per la conversione dei valori
local function get_envelope(tr, args, create)
  if args.target == "volume" or args.target == nil and args.fx == nil then
    local env = reaper.GetTrackEnvelopeByChunkName(tr, "<VOLENV2")
    if not env and create then
      with_only_track_selected(tr, function() reaper.Main_OnCommand(40406, 0) end) -- mostra envelope volume
      env = reaper.GetTrackEnvelopeByChunkName(tr, "<VOLENV2")
    end
    if not env then error("envelope volume non disponibile su " .. track_name(tr)) end
    return env, "volume"
  end
  local fx = get_fx(tr, args.fx)
  local p = get_param(tr, fx, args.param)
  local env = reaper.GetFXEnvelope(tr, fx, p, create and true or false)
  if not env then error("nessuna automazione per " .. param_name(tr, fx, p)) end
  local _, minv, maxv = reaper.TrackFX_GetParam(tr, fx, p)
  return env, "fx", { fx = fx, param = p, min = minv, max = maxv }
end

local function env_value(env, kind, info, tr, point)
  if kind == "volume" then
    local db = point.volume_db or point.value or 0
    return reaper.ScaleToEnvelopeMode(reaper.GetEnvelopeScalingMode(env), db_to_amp(db))
  end
  local norm
  if point.display ~= nil then norm = find_norm_for_display(tr, info.fx, info.param, tonumber(point.display))
  else norm = math.max(0, math.min(1, point.value or 0)) end
  return info.min + norm * (info.max - info.min)
end

local function describe_point(env, kind, info, tr, time, value)
  if kind == "volume" then
    return { time = round(time, 3), volume_db = round(amp_to_db(reaper.ScaleFromEnvelopeMode(reaper.GetEnvelopeScalingMode(env), value)), 2) }
  end
  local norm = (info.max ~= info.min) and (value - info.min) / (info.max - info.min) or 0
  local _, disp = reaper.TrackFX_FormatParamValueNormalized(tr, info.fx, info.param, norm, "")
  return { time = round(time, 3), value = round(norm, 4), display = disp }
end

function C.get_envelope(args)
  local tr = get_track(args.track)
  local env, kind, info = get_envelope(tr, args, false)
  local pts = {}
  local n = reaper.CountEnvelopePoints(env)
  for i = 0, math.min(n, 300) - 1 do
    local _, time, value = reaper.GetEnvelopePoint(env, i)
    pts[#pts + 1] = describe_point(env, kind, info, tr, time, value)
  end
  return { track = track_name(tr), kind = kind, count = n, points = pts }
end

MUTATING.set_envelope = true
function C.set_envelope(args)
  local tr = get_track(args.track)
  local env, kind, info = get_envelope(tr, args, true)
  local pts = args.points or {}
  if args.clear then
    local s, e = args.clear[1] or args.clear.start, args.clear[2] or args.clear["end"]
    if s and e then reaper.DeleteEnvelopePointRange(env, s - 0.0001, e + 0.0001) end
  elseif #pts > 0 and args.replace_range ~= false then
    -- sostituisce i punti esistenti nell'intervallo coperto dai nuovi
    local s, e = math.huge, -math.huge
    for _, pt in ipairs(pts) do s = math.min(s, pt.time); e = math.max(e, pt.time) end
    reaper.DeleteEnvelopePointRange(env, s - 0.0001, e + 0.0001)
  end
  local shape = args.shape or 0 -- 0 lineare, 1 a gradino, 2 lento, 5 bezier
  for _, pt in ipairs(pts) do
    reaper.InsertEnvelopePoint(env, pt.time, env_value(env, kind, info, tr, pt), pt.shape or shape, 0, false, true)
  end
  reaper.Envelope_SortPoints(env)
  return { track = track_name(tr), kind = kind, points_added = #pts, total_points = reaper.CountEnvelopePoints(env) }
end

---------------------------------------------------------------------------
-- Sidechain: la traccia "source" pilota il compressore sulla traccia "target"
---------------------------------------------------------------------------
MUTATING.setup_sidechain = true
function C.setup_sidechain(args)
  local src = get_track(args.source)
  local dst = get_track(args.target)
  if src == dst then error("sorgente e destinazione coincidono") end
  if reaper.GetMediaTrackInfo_Value(dst, "I_NCHAN") < 4 then reaper.SetMediaTrackInfo_Value(dst, "I_NCHAN", 4) end
  local send = reaper.CreateTrackSend(src, dst)
  if send < 0 then error("impossibile creare il send") end
  reaper.SetTrackSendInfo_Value(src, 0, send, "I_SRCCHAN", 0)   -- canali 1/2 della sorgente
  reaper.SetTrackSendInfo_Value(src, 0, send, "I_DSTCHAN", 2)   -- verso i canali 3/4 della destinazione
  reaper.SetTrackSendInfo_Value(src, 0, send, "D_VOL", db_to_amp(args.send_db or 0))

  local fx
  if args.fx ~= nil then fx = get_fx(dst, args.fx)
  else
    local ok, found = pcall(get_fx, dst, "ReaComp")
    fx = ok and found or reaper.TrackFX_AddByName(dst, "ReaComp", false, -1)
    if fx < 0 then error("ReaComp non trovato") end
  end
  -- ingressi 3/4 del plugin = canali 3/4 della traccia (sidechain)
  reaper.TrackFX_SetPinMappings(dst, fx, 0, 2, 4, 0)
  reaper.TrackFX_SetPinMappings(dst, fx, 0, 3, 8, 0)

  -- se il plugin ha un parametro "detector input", lo porto sull'ingresso ausiliario
  local detector
  for p = 0, reaper.TrackFX_GetNumParams(dst, fx) - 1 do
    if param_name(dst, fx, p):lower():find("detector") then
      for step = 0, 100 do
        local x = step / 100
        local ok, s = reaper.TrackFX_FormatParamValueNormalized(dst, fx, p, x, "")
        if ok and s:lower():find("aux") then
          reaper.TrackFX_SetParamNormalized(dst, fx, p, x)
          detector = formatted(dst, fx, p)
          break
        end
      end
      break
    end
  end
  return {
    source = track_name(src), target = track_name(dst), send_index = send, fx_index = fx, fx = fx_name(dst, fx),
    detector = detector or "non trovato: imposta l'ingresso sidechain del plugin (canali 3/4) a mano o con set_fx_params",
  }
end

---------------------------------------------------------------------------
-- IPC loop
---------------------------------------------------------------------------
local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local s = f:read("*a")
  f:close()
  return s
end

local function write_atomic(path, content)
  local tmp = path .. ".tmp"
  local f = io.open(tmp, "wb")
  if not f then return false end
  f:write(content)
  f:close()
  os.remove(path)
  return os.rename(tmp, path)
end

local function handle(cmd)
  local fn = C[cmd.cmd]
  if not fn then return { ok = false, error = "comando sconosciuto: " .. tostring(cmd.cmd) } end
  local args = cmd.args or {}
  local mutating = MUTATING[cmd.cmd]
  if mutating then
    reaper.Undo_BeginBlock()
    reaper.PreventUIRefresh(1)
  end
  local ok, res = pcall(fn, args)
  if mutating then
    reaper.PreventUIRefresh(-1)
    refresh()
    reaper.Undo_EndBlock("Copilot: " .. cmd.cmd, -1)
  end
  if ok then return { ok = true, result = res } end
  return { ok = false, error = (tostring(res):gsub("^[^\n]-:%d+: ", "")) }
end

local function poll()
  if reaper.EnumerateFiles(IPC_DIR, -1) == nil then end -- invalida la cache della lista file
  local files = {}
  local i = 0
  while true do
    local f = reaper.EnumerateFiles(IPC_DIR, i)
    if not f then break end
    if f:match("%.cmd%.json$") then files[#files + 1] = f end
    i = i + 1
  end
  table.sort(files)
  for _, f in ipairs(files) do
    local path = IPC_DIR .. f
    local content = read_file(path)
    os.remove(path)
    if content and content ~= "" then
      local id = f:gsub("%.cmd%.json$", "")
      local ok, cmd = pcall(json.decode, content)
      local response
      if not ok then response = { ok = false, error = "JSON non valido: " .. tostring(cmd) }
      else response = handle(cmd) end
      response.id = id
      write_atomic(IPC_DIR .. id .. ".res.json", json.encode(response))
    end
  end
end

local function project_path()
  local ok, _, fn = pcall(reaper.EnumProjects, -1)
  if ok and fn then return fn end
  return ""
end

local function heartbeat(state)
  local _, proj_name = reaper.GetProjectName(0, "")
  write_atomic(IPC_DIR .. "heartbeat.json", json.encode({
    state = state, bridge = VERSION, reaper = reaper.GetAppVersion(),
    project = proj_name, project_path = project_path(), time = os.time(),
  }))
end

local last_poll, last_hb = 0, 0
local function loop()
  local now = reaper.time_precise()
  if now - last_poll >= 0.08 then
    last_poll = now
    local ok, e = pcall(poll)
    if not ok then reaper.ShowConsoleMsg("[Copilot] errore: " .. tostring(e) .. "\n") end
  end
  if now - last_hb >= 1 then
    last_hb = now
    heartbeat("running")
  end
  reaper.defer(loop)
end

-- toggle sulla toolbar
local _, _, section, cmd_id = reaper.get_action_context()
local function set_toggle(v)
  if cmd_id and cmd_id > 0 then
    reaper.SetToggleCommandState(section, cmd_id, v)
    reaper.RefreshToolbar2(section, cmd_id)
  end
end

if not json_test_mode then
  reaper.RecursiveCreateDirectory(IPC_DIR, 0)
  set_toggle(1)
  reaper.atexit(function()
    heartbeat("stopped")
    set_toggle(0)
  end)
  loop()
end

return { json = json, C = C, handle = handle, parse_num = parse_num, poll = poll }
