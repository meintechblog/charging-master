/**
 * v1.7-A++ : Build a downloadable iOS Shortcut (.shortcut XML plist).
 *
 * Given a plug ID and the LAN base URL, produce a property-list document
 * Shortcuts.app can import. The Shortcut reads the iPhone/iPad battery
 * level, scales it to 0–100, rounds, and POSTs `{soc: <int>}` to the
 * plug's `/api/devices/<id>/report-soc` endpoint.
 *
 * UUIDs are derived deterministically from `plugId:index` via SHA-1 so
 * the same plug produces a byte-identical plist (testable, cacheable),
 * but two different plugs produce different Magic-Variable chains.
 *
 * Note on iOS trust: this is an *unsigned* shortcut. The user must have
 * "Allow Untrusted Shortcuts" enabled in iOS Settings → Shortcuts.
 * That toggle only appears AFTER the user has run at least one shortcut.
 */
import { createHash } from 'node:crypto';

export type BuildShortcutInput = {
  plugId: string;
  plugName: string;
  baseUrl: string;
};

/**
 * Derive a deterministic UUID-shaped string from a seed. We use SHA-1
 * (per RFC 4122 v5) but ALWAYS within our own namespace, so callers
 * cannot use a third-party UUID library to interop — these are internal
 * identifiers only used inside one Shortcut document.
 */
function uuidFromSeed(seed: string): string {
  const h = createHash('sha1').update(`charging-master:ios-shortcut:${seed}`).digest('hex');
  // Format as 8-4-4-4-12 lowercase, version 5 (per RFC 4122 §4.1.3).
  const v5Byte = ((parseInt(h.slice(12, 14), 16) & 0x0f) | 0x50).toString(16).padStart(2, '0');
  const variantByte = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `${v5Byte}${h.slice(14, 16)}`,
    `${variantByte}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-').toUpperCase();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the full XML plist body. Pure function — same input ⇒ byte-
 * identical output.
 */
export function buildReportSocShortcutPlist(input: BuildShortcutInput): string {
  const { plugId, plugName, baseUrl } = input;

  const uuidA = uuidFromSeed(`${plugId}:0:getbatterylevel`);
  const uuidB = uuidFromSeed(`${plugId}:1:math`);
  const uuidC = uuidFromSeed(`${plugId}:2:round`);
  const uuidD = uuidFromSeed(`${plugId}:3:dictionary`);
  const uuidE = uuidFromSeed(`${plugId}:4:downloadurl`);

  const postUrl = `${baseUrl.replace(/\/$/, '')}/api/devices/${plugId}/report-soc`;
  const escapedUrl = escapeXml(postUrl);
  const escapedName = escapeXml(plugName);

  // Each Magic Variable reference uses a 1-char placeholder ("￼", the
  // OBJECT REPLACEMENT CHARACTER, which Shortcuts.app uses internally) and
  // an attachmentsByRange map keyed by NSRange "{location, length}".
  // We use the simpler ActionOutput attachment for non-text-attachment slots.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>WFWorkflowActions</key>
\t<array>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.getbatterylevel</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuidA}</string>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.math</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuidB}</string>
\t\t\t\t<key>WFInput</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t<string>ActionOutput</string>
\t\t\t\t\t\t<key>OutputUUID</key>
\t\t\t\t\t\t<string>${uuidA}</string>
\t\t\t\t\t\t<key>OutputName</key>
\t\t\t\t\t\t<string>Battery Level</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFTextTokenAttachment</string>
\t\t\t\t</dict>
\t\t\t\t<key>WFMathOperand</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>Number</key>
\t\t\t\t\t\t<integer>100</integer>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFNumberSubstitutableState</string>
\t\t\t\t</dict>
\t\t\t\t<key>WFMathOperation</key>
\t\t\t\t<string>×</string>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.round</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuidC}</string>
\t\t\t\t<key>WFInput</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t<string>ActionOutput</string>
\t\t\t\t\t\t<key>OutputUUID</key>
\t\t\t\t\t\t<string>${uuidB}</string>
\t\t\t\t\t\t<key>OutputName</key>
\t\t\t\t\t\t<string>Calculation Result</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFTextTokenAttachment</string>
\t\t\t\t</dict>
\t\t\t\t<key>WFRoundMode</key>
\t\t\t\t<string>Normal</string>
\t\t\t\t<key>WFRoundTo</key>
\t\t\t\t<string>Ones Place</string>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.dictionary</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuidD}</string>
\t\t\t\t<key>WFItems</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>WFDictionaryFieldValueItems</key>
\t\t\t\t\t\t<array>
\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t<key>WFItemType</key>
\t\t\t\t\t\t\t\t<integer>3</integer>
\t\t\t\t\t\t\t\t<key>WFKey</key>
\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t<key>Value</key>
\t\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t\t<key>string</key>
\t\t\t\t\t\t\t\t\t\t<string>soc</string>
\t\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t\t\t\t\t<string>WFTextTokenString</string>
\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t<key>WFValue</key>
\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t<key>Value</key>
\t\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t\t\t\t\t<string>ActionOutput</string>
\t\t\t\t\t\t\t\t\t\t<key>OutputUUID</key>
\t\t\t\t\t\t\t\t\t\t<string>${uuidC}</string>
\t\t\t\t\t\t\t\t\t\t<key>OutputName</key>
\t\t\t\t\t\t\t\t\t\t<string>Rounded Number</string>
\t\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t\t\t\t\t<string>WFTextTokenAttachment</string>
\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t</array>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFDictionaryFieldValue</string>
\t\t\t\t</dict>
\t\t\t</dict>
\t\t</dict>
\t\t<dict>
\t\t\t<key>WFWorkflowActionIdentifier</key>
\t\t\t<string>is.workflow.actions.downloadurl</string>
\t\t\t<key>WFWorkflowActionParameters</key>
\t\t\t<dict>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${uuidE}</string>
\t\t\t\t<key>Advanced</key>
\t\t\t\t<true/>
\t\t\t\t<key>ShowHeaders</key>
\t\t\t\t<true/>
\t\t\t\t<key>WFHTTPBodyType</key>
\t\t\t\t<string>JSON</string>
\t\t\t\t<key>WFHTTPHeaders</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>WFDictionaryFieldValueItems</key>
\t\t\t\t\t\t<array>
\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t<key>WFItemType</key>
\t\t\t\t\t\t\t\t<integer>0</integer>
\t\t\t\t\t\t\t\t<key>WFKey</key>
\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t<key>Value</key>
\t\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t\t<key>string</key>
\t\t\t\t\t\t\t\t\t\t<string>Content-Type</string>
\t\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t\t\t\t\t<string>WFTextTokenString</string>
\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t<key>WFValue</key>
\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t<key>Value</key>
\t\t\t\t\t\t\t\t\t<dict>
\t\t\t\t\t\t\t\t\t\t<key>string</key>
\t\t\t\t\t\t\t\t\t\t<string>application/json</string>
\t\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t\t\t\t\t<string>WFTextTokenString</string>
\t\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t\t</dict>
\t\t\t\t\t\t</array>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFDictionaryFieldValue</string>
\t\t\t\t</dict>
\t\t\t\t<key>WFHTTPMethod</key>
\t\t\t\t<string>POST</string>
\t\t\t\t<key>WFJSONValues</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Value</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>Type</key>
\t\t\t\t\t\t<string>ActionOutput</string>
\t\t\t\t\t\t<key>OutputUUID</key>
\t\t\t\t\t\t<string>${uuidD}</string>
\t\t\t\t\t\t<key>OutputName</key>
\t\t\t\t\t\t<string>Dictionary</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>WFSerializationType</key>
\t\t\t\t\t<string>WFTextTokenAttachment</string>
\t\t\t\t</dict>
\t\t\t\t<key>WFURL</key>
\t\t\t\t<string>${escapedUrl}</string>
\t\t\t</dict>
\t\t</dict>
\t</array>
\t<key>WFWorkflowClientRelease</key>
\t<string>2.2.2</string>
\t<key>WFWorkflowClientVersion</key>
\t<string>2605.0.4</string>
\t<key>WFWorkflowHasOutputFallback</key>
\t<false/>
\t<key>WFWorkflowHasShortcutInputVariables</key>
\t<false/>
\t<key>WFWorkflowIcon</key>
\t<dict>
\t\t<key>WFWorkflowIconStartColor</key>
\t\t<integer>946986751</integer>
\t\t<key>WFWorkflowIconGlyphNumber</key>
\t\t<integer>59446</integer>
\t</dict>
\t<key>WFWorkflowImportQuestions</key>
\t<array/>
\t<key>WFWorkflowInputContentItemClasses</key>
\t<array>
\t\t<string>WFAppContentItem</string>
\t\t<string>WFAppStoreAppContentItem</string>
\t\t<string>WFArticleContentItem</string>
\t\t<string>WFContactContentItem</string>
\t\t<string>WFDateContentItem</string>
\t\t<string>WFEmailAddressContentItem</string>
\t\t<string>WFFolderContentItem</string>
\t\t<string>WFGenericFileContentItem</string>
\t\t<string>WFImageContentItem</string>
\t\t<string>WFiTunesProductContentItem</string>
\t\t<string>WFLocationContentItem</string>
\t\t<string>WFDCMapsLinkContentItem</string>
\t\t<string>WFAVAssetContentItem</string>
\t\t<string>WFPDFContentItem</string>
\t\t<string>WFPhoneNumberContentItem</string>
\t\t<string>WFRichTextContentItem</string>
\t\t<string>WFSafariWebPageContentItem</string>
\t\t<string>WFStringContentItem</string>
\t\t<string>WFURLContentItem</string>
\t</array>
\t<key>WFWorkflowMinimumClientVersion</key>
\t<integer>900</integer>
\t<key>WFWorkflowMinimumClientVersionString</key>
\t<string>900</string>
\t<key>WFWorkflowName</key>
\t<string>Charging-Master SoC (${escapedName})</string>
\t<key>WFWorkflowOutputContentItemClasses</key>
\t<array/>
\t<key>WFWorkflowTypes</key>
\t<array>
\t\t<string>NCWidget</string>
\t\t<string>WatchKit</string>
\t</array>
</dict>
</plist>
`;
}

/**
 * Build a filename-safe slug for the .shortcut download.
 * Strips characters that misbehave in HTTP Content-Disposition.
 */
export function plugFilenameSlug(plugName: string): string {
  const cleaned = plugName
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'plug';
}
