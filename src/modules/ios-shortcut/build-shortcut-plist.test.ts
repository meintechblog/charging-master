import { describe, it, expect } from 'vitest';
import { buildReportSocShortcutPlist, plugFilenameSlug } from './build-shortcut-plist';

const canonical = {
  plugId: 'shellyplugsg3-d885ac15b828',
  plugName: 'Büro',
  baseUrl: 'http://charging-master.local',
};

describe('buildReportSocShortcutPlist', () => {
  it('starts with the XML preamble and DOCTYPE plist', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trimEnd().endsWith('</plist>')).toBe(true);
  });

  it('bakes the POST URL with the literal plug ID', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    expect(xml).toContain(
      '<string>http://charging-master.local/api/devices/shellyplugsg3-d885ac15b828/report-soc</string>'
    );
  });

  it('escapes plug name XML-specials in the WFWorkflowName', () => {
    const xml = buildReportSocShortcutPlist({
      ...canonical,
      plugName: 'Lab <Test> & "Demo"',
    });
    expect(xml).toContain('<string>Charging-Master SoC (Lab &lt;Test&gt; &amp; &quot;Demo&quot;)</string>');
    expect(xml).not.toContain('Charging-Master SoC (Lab <Test>');
  });

  it('chains all five expected action identifiers in order', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    const ids = [
      'is.workflow.actions.getbatterylevel',
      'is.workflow.actions.math',
      'is.workflow.actions.round',
      'is.workflow.actions.dictionary',
      'is.workflow.actions.downloadurl',
    ];
    let lastIndex = -1;
    for (const id of ids) {
      const idx = xml.indexOf(id);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('assigns a unique UUID per action', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    // Collect all 36-char UUID-formatted strings inside <string>UUID</string>.
    const matches = xml.match(/<string>[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}<\/string>/g);
    expect(matches).not.toBeNull();
    // 5 distinct UUIDs, but each is referenced more than once (UUID + OutputUUID
    // back-reference). Distinct count must equal 5.
    const distinct = new Set(matches!.map((m) => m.replace(/<\/?string>/g, '')));
    expect(distinct.size).toBe(5);
  });

  it('chains Magic Variables: math.WFInput.OutputUUID === getbatterylevel.UUID', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    // Find the getbatterylevel action's UUID
    const aMatch = xml.match(/is\.workflow\.actions\.getbatterylevel[\s\S]*?<key>UUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    const bMatch = xml.match(/is\.workflow\.actions\.math[\s\S]*?<key>WFInput<\/key>[\s\S]*?<key>OutputUUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    expect(aMatch).not.toBeNull();
    expect(bMatch).not.toBeNull();
    expect(bMatch![1]).toBe(aMatch![1]);
  });

  it('chains Magic Variables: round → math → getbatterylevel', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    const bMatch = xml.match(/is\.workflow\.actions\.math[\s\S]*?<key>UUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    const cInput = xml.match(/is\.workflow\.actions\.round[\s\S]*?<key>WFInput<\/key>[\s\S]*?<key>OutputUUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    expect(bMatch).not.toBeNull();
    expect(cInput).not.toBeNull();
    expect(cInput![1]).toBe(bMatch![1]);
  });

  it('chains Magic Variables: downloadurl.WFJSONValues → dictionary.UUID', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    const dMatch = xml.match(/is\.workflow\.actions\.dictionary[\s\S]*?<key>UUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    const eInput = xml.match(/is\.workflow\.actions\.downloadurl[\s\S]*?<key>WFJSONValues<\/key>[\s\S]*?<key>OutputUUID<\/key>\s*<string>([0-9A-F-]+)<\/string>/);
    expect(dMatch).not.toBeNull();
    expect(eInput).not.toBeNull();
    expect(eInput![1]).toBe(dMatch![1]);
  });

  it('produces byte-identical output for identical input (deterministic)', () => {
    const a = buildReportSocShortcutPlist(canonical);
    const b = buildReportSocShortcutPlist(canonical);
    expect(a).toBe(b);
  });

  it('produces DIFFERENT UUIDs for different plug IDs', () => {
    const a = buildReportSocShortcutPlist(canonical);
    const b = buildReportSocShortcutPlist({ ...canonical, plugId: 'shellyplugsg3-9070694940e4' });
    const uuidsA = new Set(
      (a.match(/<string>[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}<\/string>/g) ?? [])
        .map((m) => m.replace(/<\/?string>/g, ''))
    );
    const uuidsB = new Set(
      (b.match(/<string>[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}<\/string>/g) ?? [])
        .map((m) => m.replace(/<\/?string>/g, ''))
    );
    // No UUID overlap between the two plugs' shortcut documents.
    for (const u of uuidsA) {
      expect(uuidsB.has(u)).toBe(false);
    }
  });

  it('UUIDs are RFC4122 v5-shaped (version nibble = 5, variant = 8/9/A/B)', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    const matches = xml.match(/<string>([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})<\/string>/g);
    expect(matches).not.toBeNull();
    for (const m of matches!) {
      const uuid = m.replace(/<\/?string>/g, '');
      expect(uuid[14]).toBe('5');
      expect(['8', '9', 'A', 'B']).toContain(uuid[19]);
    }
  });

  it('snapshot: canonical Büro/iPad shortcut is stable', () => {
    const xml = buildReportSocShortcutPlist(canonical);
    expect(xml).toMatchSnapshot();
  });
});

describe('plugFilenameSlug', () => {
  it('returns simple names unchanged', () => {
    expect(plugFilenameSlug('Buero')).toBe('Buero');
  });

  it('replaces non-word characters with single dashes', () => {
    // 'ü' → NFKD → 'u' + combining diaeresis; diaeresis is non-\w so dropped.
    expect(plugFilenameSlug('Büro Lab #1')).toBe('Bu-ro-Lab-1');
  });

  it('strips leading and trailing dashes', () => {
    expect(plugFilenameSlug('--weird@@')).toBe('weird');
  });

  it('falls back to "plug" for empty/garbage input', () => {
    expect(plugFilenameSlug('')).toBe('plug');
    expect(plugFilenameSlug('@@@')).toBe('plug');
  });
});
