// Etichette leggibili per le azioni dell'agente.
const t = (v) => (v === 'master' || v === -1 ? 'Master' : v === undefined ? '' : typeof v === 'number' || /^\d+$/.test(String(v)) ? `traccia ${Number(v) + 1}` : v);

const fmtRange = (r) => {
  if (!r || r === 'project') return 'intero brano';
  if (r === 'time_selection') return 'time selection';
  if (typeof r === 'object') return `${r.start}s–${r.end}s`;
  return String(r);
};

export function toolLabel(name, input = {}) {
  switch (name) {
    case 'get_project': return 'Legge il progetto';
    case 'get_fx_params': return `Legge i parametri di ${input.fx} · ${t(input.track)}`;
    case 'set_track': {
      const bits = [];
      if (input.volume_db !== undefined) bits.push(`vol ${input.volume_db > 0 ? '+' : ''}${input.volume_db} dB`);
      if (input.pan !== undefined) bits.push(`pan ${Math.round(input.pan * 100)}`);
      if (input.mute !== undefined) bits.push(input.mute ? 'mute' : 'unmute');
      if (input.solo !== undefined) bits.push(input.solo ? 'solo' : 'unsolo');
      if (input.name) bits.push(`rinomina "${input.name}"`);
      if (input.phase_inverted !== undefined) bits.push('fase');
      return `${t(input.track)} · ${bits.join(', ') || 'modifica'}`;
    }
    case 'create_track': return `Crea traccia "${input.name}"`;
    case 'delete_track': return `Elimina ${t(input.track)}`;
    case 'add_fx': return `Aggiunge ${input.fx_name} · ${t(input.track)}`;
    case 'remove_fx': return `Rimuove ${input.fx} · ${t(input.track)}`;
    case 'set_fx_enabled': return `${input.enabled ? 'Attiva' : 'Bypassa'} ${input.fx} · ${t(input.track)}`;
    case 'set_fx_params': {
      const ps = (input.params || []).map((p) => `${p.param}${p.display !== undefined ? ` ${p.display}` : ''}`).join(', ');
      return `${input.fx} · ${t(input.track)}: ${ps}`;
    }
    case 'get_fx_named_config': return `Legge config ${input.fx}`;
    case 'set_fx_named_config': return `Config ${input.fx}: ${input.key}=${input.value}`;
    case 'add_send': return `Send ${t(input.src)} → ${t(input.dst)}`;
    case 'set_send': return `Modifica send di ${t(input.src)}`;
    case 'set_time_selection': return `Time selection ${input.start}s–${input.end}s`;
    case 'list_installed_fx': return `Cerca plugin${input.filter ? ` "${input.filter}"` : ''}`;
    case 'render_and_analyze':
      return `Render e analisi · ${t(input.target ?? 'master')} · ${fmtRange(input.range)}${input.compare_to_reference ? ` vs ${input.compare_to_reference}${input.reference_stem ? ` (${input.reference_stem})` : ''}` : ''}`;
    case 'mix_report': return `Rapporto di mix${input.reference ? ` vs ${input.reference}` : ''}${input.range ? ` · ${fmtRange(input.range)}` : ''}`;
    case 'apply_mix_plan': {
      const n = (input.tracks || []).length;
      return `Applica piano di mix · ${n} tracc${n === 1 ? 'ia' : 'e'}${input.master ? ' + master' : ''}`;
    }
    case 'list_references': return 'Elenca le reference';
    case 'separate_reference': return `Separa in stem "${input.reference}"`;
    case 'analyze_reference': return `Analizza reference "${input.reference}"${input.stem ? ` · ${input.stem}` : ''}`;
    case 'list_items': return `Legge gli item · ${t(input.track)}`;
    case 'edit_item': {
      const bits = [];
      if (input.volume_db !== undefined) bits.push(`gain ${input.volume_db > 0 ? '+' : ''}${input.volume_db} dB`);
      if (input.fade_in !== undefined) bits.push(`fade in ${input.fade_in}s`);
      if (input.fade_out !== undefined) bits.push(`fade out ${input.fade_out}s`);
      if (input.trim_start !== undefined) bits.push(`trim ${input.trim_start}s`);
      if (input.move_by !== undefined) bits.push(`sposta ${input.move_by}s`);
      if (input.position !== undefined) bits.push(`a ${input.position}s`);
      if (input.mute !== undefined) bits.push(input.mute ? 'mute' : 'unmute');
      const which = input.item !== undefined ? `item ${input.item + 1}` : input.at !== undefined ? `item a ${input.at}s` : 'item';
      return `${t(input.track)} · ${which}: ${bits.join(', ') || 'modifica'}`;
    }
    case 'split_item': return `Taglia ${t(input.track)} a ${(input.times || []).map((x) => `${x}s`).join(', ')}`;
    case 'delete_item': return `Elimina ${input.item !== undefined ? `item ${input.item + 1}` : `item a ${input.at}s`} · ${t(input.track)}`;
    case 'get_envelope': return `Legge automazione ${input.fx ? `${input.fx} ${input.param}` : 'volume'} · ${t(input.track)}`;
    case 'set_envelope': return `Automazione ${input.fx ? `${input.fx} · ${input.param}` : 'volume'} · ${t(input.track)}${input.points ? ` (${input.points.length} punti)` : ''}`;
    case 'setup_sidechain': return `Sidechain ${t(input.source)} → ${t(input.target)}`;
    case 'update_notes': return input.scope === 'user' ? 'Aggiorna le tue preferenze' : 'Aggiorna le note del progetto';
    case 'undo': return 'Annulla ultima azione';
    case 'run_action': return `Esegue azione ${input.id}`;
    case 'run_lua': return 'Esegue script Lua';
    default: return name;
  }
}

export const TOOL_GLYPH = {
  render_and_analyze: '◉',
  mix_report: '◉',
  apply_mix_plan: '▤',
  analyze_reference: '◉',
  separate_reference: '≋',
  add_fx: '+',
  remove_fx: '−',
  set_fx_params: '⌁',
  set_track: '⇅',
  set_envelope: '∿',
  setup_sidechain: '⇢',
  split_item: '✂',
  edit_item: '▭',
  update_notes: '✎',
  run_lua: '{}',
};
