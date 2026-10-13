-- REAPER Copilot bridge
-- Carica questo script in REAPER (Actions > New action > Load ReaScript...) e lancialo.
-- Resta in esecuzione in background e scambia comandi JSON con il server Node
-- tramite la cartella "ipc" accanto allo script.

local VERSION = "0.1.0"

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
local function set_param_by_display(tr, fx, p, target)
  local function probe(x)
    local ok, s = reaper.TrackFX_FormatParamValueNormalized(tr, fx, p, x, "")
    if not ok or s == "" then
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
  reaper.TrackFX_SetParamNormalized(tr, fx, p, best)
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

  -- solo della traccia richiesta (solo-in-place) se non è il master
  local saved_solo = {}
  local warn
  local solo_target = nil
  if target ~= "master" and target ~= -1 and target ~= "MASTER" then
    solo_target = get_track(target)
    if reaper.GetMediaTrackInfo_Value(solo_target, "B_MUTE") == 1 then
      warn = "la traccia è in mute: il render sarà silenzioso"
    end
    for i = 0, reaper.CountTracks(0) - 1 do
      local tr = reaper.GetTrack(0, i)
      saved_solo[i] = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO")
      reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", 0)
    end
    reaper.SetMediaTrackInfo_Value(solo_target, "I_SOLO", 2)
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
  local _, num, den = reaper.TimeMap_GetTimeSigAtTime(0, 0)
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

MUTATING.add_fx = true
function C.add_fx(args)
  local tr = get_track(args.track)
  local idx = reaper.TrackFX_AddByName(tr, args.fx_name, false, -1)
  if idx < 0 then error("plugin '" .. tostring(args.fx_name) .. "' non trovato. Usa list_installed_fx per i nomi esatti") end
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
  if not reaper.EnumInstalledFX then
    return { unsupported = true, hint = "REAPER troppo vecchio per EnumInstalledFX; prova i plugin Cockos (ReaEQ, ReaComp, ReaXcomp, ReaLimit, ReaVerbate, ReaDelay)" }
  end
  local filter = args.filter and tostring(args.filter):lower()
  local out = {}
  local i = 0
  while true do
    local ok, name = reaper.EnumInstalledFX(i)
    if not ok then break end
    if not filter or name:lower():find(filter, 1, true) then out[#out + 1] = name end
    if #out >= (args.limit or 200) then break end
    i = i + 1
  end
  return { fx = out }
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

local function heartbeat(state)
  local _, proj_name = reaper.GetProjectName(0, "")
  write_atomic(IPC_DIR .. "heartbeat.json", json.encode({
    state = state, bridge = VERSION, reaper = reaper.GetAppVersion(),
    project = proj_name, time = os.time(),
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
