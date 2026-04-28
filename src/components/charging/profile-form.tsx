'use client';

import { useState } from 'react';

export type ProfileFormValues = {
  // Identity / commercial
  name: string;
  description: string;
  manufacturer: string;
  modelName: string;
  articleNumber: string;
  gtin: string;
  capacityWh: number | null;
  weightGrams: number | null;
  purchaseDate: string;
  estimatedCycles: number | null;
  productUrl: string;
  documentUrl: string;
  priceEur: number | null;
  // Cell + chemistry
  chemistry: string;
  cellDesignation: string;
  cellConfiguration: string;
  nominalVoltageV: number | null;
  nominalCapacityMah: number | null;
  batteryFormFactor: string;
  replaceable: boolean | null;
  // Charge spec
  maxChargeCurrentA: number | null;
  maxChargeVoltageV: number | null;
  chargeTempMinC: number | null;
  chargeTempMaxC: number | null;
  chargerModel: string;
  chargerEfficiency: number | null;
  // Identity / provenance
  serialNumber: string;
  productionDate: string;
  countryOfOrigin: string;
  certifications: string[] | null;
  // Lifecycle / warranty
  endOfLifeCapacityPct: number | null;
  warrantyUntil: string;
  warrantyCycles: number | null;
  // Free-form
  notes: string;
};

type ProfileFormProps = {
  initialValues?: Partial<ProfileFormValues>;
  onSubmit: (values: ProfileFormValues) => void;
  submitLabel?: string;
  disabled?: boolean;
};

const INPUT_CLASS =
  'w-full bg-neutral-800 border border-neutral-700 text-neutral-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 transition-colors';

const LABEL_CLASS = 'block text-sm font-medium text-neutral-300 mb-1';

const SECTION_HEADER_CLASS = 'text-xs font-semibold uppercase tracking-wider text-neutral-500 pt-4 pb-1 border-t border-neutral-800 first:border-t-0 first:pt-0';

function strOrEmpty(v: string | null | undefined): string {
  return v ?? '';
}
function numOrEmpty(v: number | null | undefined): string {
  return v != null ? String(v) : '';
}

export function ProfileForm({
  initialValues,
  onSubmit,
  submitLabel = 'Speichern',
  disabled,
}: ProfileFormProps) {
  // --- Identity / commercial ---
  const [name, setName] = useState(strOrEmpty(initialValues?.name));
  const [description, setDescription] = useState(strOrEmpty(initialValues?.description));
  const [manufacturer, setManufacturer] = useState(strOrEmpty(initialValues?.manufacturer));
  const [modelName, setModelName] = useState(strOrEmpty(initialValues?.modelName));
  const [articleNumber, setArticleNumber] = useState(strOrEmpty(initialValues?.articleNumber));
  const [gtin, setGtin] = useState(strOrEmpty(initialValues?.gtin));
  const [capacityWh, setCapacityWh] = useState(numOrEmpty(initialValues?.capacityWh));
  const [weightGrams, setWeightGrams] = useState(numOrEmpty(initialValues?.weightGrams));
  const [purchaseDate, setPurchaseDate] = useState(strOrEmpty(initialValues?.purchaseDate));
  const [estimatedCycles, setEstimatedCycles] = useState(numOrEmpty(initialValues?.estimatedCycles));
  const [productUrl, setProductUrl] = useState(strOrEmpty(initialValues?.productUrl));
  const [documentUrl, setDocumentUrl] = useState(strOrEmpty(initialValues?.documentUrl));
  const [priceEur, setPriceEur] = useState(numOrEmpty(initialValues?.priceEur));

  // --- Cell + chemistry ---
  const [chemistry, setChemistry] = useState(strOrEmpty(initialValues?.chemistry));
  const [cellDesignation, setCellDesignation] = useState(strOrEmpty(initialValues?.cellDesignation));
  const [cellConfiguration, setCellConfiguration] = useState(strOrEmpty(initialValues?.cellConfiguration));
  const [nominalVoltageV, setNominalVoltageV] = useState(numOrEmpty(initialValues?.nominalVoltageV));
  const [nominalCapacityMah, setNominalCapacityMah] = useState(numOrEmpty(initialValues?.nominalCapacityMah));
  const [batteryFormFactor, setBatteryFormFactor] = useState(strOrEmpty(initialValues?.batteryFormFactor));
  const [replaceable, setReplaceable] = useState<'unknown' | 'yes' | 'no'>(
    initialValues?.replaceable === true ? 'yes' : initialValues?.replaceable === false ? 'no' : 'unknown'
  );

  // --- Charge spec ---
  const [maxChargeCurrentA, setMaxChargeCurrentA] = useState(numOrEmpty(initialValues?.maxChargeCurrentA));
  const [maxChargeVoltageV, setMaxChargeVoltageV] = useState(numOrEmpty(initialValues?.maxChargeVoltageV));
  const [chargeTempMinC, setChargeTempMinC] = useState(numOrEmpty(initialValues?.chargeTempMinC));
  const [chargeTempMaxC, setChargeTempMaxC] = useState(numOrEmpty(initialValues?.chargeTempMaxC));
  const [chargerModel, setChargerModel] = useState(strOrEmpty(initialValues?.chargerModel));
  const [chargerEfficiency, setChargerEfficiency] = useState(numOrEmpty(initialValues?.chargerEfficiency));

  // --- Identity / provenance ---
  const [serialNumber, setSerialNumber] = useState(strOrEmpty(initialValues?.serialNumber));
  const [productionDate, setProductionDate] = useState(strOrEmpty(initialValues?.productionDate));
  const [countryOfOrigin, setCountryOfOrigin] = useState(strOrEmpty(initialValues?.countryOfOrigin));
  const [certificationsCsv, setCertificationsCsv] = useState(
    Array.isArray(initialValues?.certifications) ? initialValues!.certifications!.join(', ') : ''
  );

  // --- Lifecycle / warranty ---
  const [endOfLifeCapacityPct, setEndOfLifeCapacityPct] = useState(numOrEmpty(initialValues?.endOfLifeCapacityPct));
  const [warrantyUntil, setWarrantyUntil] = useState(strOrEmpty(initialValues?.warrantyUntil));
  const [warrantyCycles, setWarrantyCycles] = useState(numOrEmpty(initialValues?.warrantyCycles));

  // --- Notes ---
  const [notes, setNotes] = useState(strOrEmpty(initialValues?.notes));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const certifications = certificationsCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    onSubmit({
      name: name.trim(),
      description: description.trim(),
      manufacturer: manufacturer.trim(),
      modelName: modelName.trim(),
      articleNumber: articleNumber.trim(),
      gtin: gtin.trim(),
      capacityWh: capacityWh ? parseFloat(capacityWh) : null,
      weightGrams: weightGrams ? parseInt(weightGrams, 10) : null,
      purchaseDate,
      estimatedCycles: estimatedCycles ? parseInt(estimatedCycles, 10) : null,
      productUrl: productUrl.trim(),
      documentUrl: documentUrl.trim(),
      priceEur: priceEur ? parseFloat(priceEur) : null,
      chemistry: chemistry.trim(),
      cellDesignation: cellDesignation.trim(),
      cellConfiguration: cellConfiguration.trim(),
      nominalVoltageV: nominalVoltageV ? parseFloat(nominalVoltageV) : null,
      nominalCapacityMah: nominalCapacityMah ? parseInt(nominalCapacityMah, 10) : null,
      batteryFormFactor: batteryFormFactor.trim(),
      replaceable: replaceable === 'yes' ? true : replaceable === 'no' ? false : null,
      maxChargeCurrentA: maxChargeCurrentA ? parseFloat(maxChargeCurrentA) : null,
      maxChargeVoltageV: maxChargeVoltageV ? parseFloat(maxChargeVoltageV) : null,
      chargeTempMinC: chargeTempMinC ? parseInt(chargeTempMinC, 10) : null,
      chargeTempMaxC: chargeTempMaxC ? parseInt(chargeTempMaxC, 10) : null,
      chargerModel: chargerModel.trim(),
      chargerEfficiency: chargerEfficiency ? parseFloat(chargerEfficiency) : null,
      serialNumber: serialNumber.trim(),
      productionDate: productionDate.trim(),
      countryOfOrigin: countryOfOrigin.trim(),
      certifications: certifications.length > 0 ? certifications : null,
      endOfLifeCapacityPct: endOfLifeCapacityPct ? parseInt(endOfLifeCapacityPct, 10) : null,
      warrantyUntil: warrantyUntil.trim(),
      warrantyCycles: warrantyCycles ? parseInt(warrantyCycles, 10) : null,
      notes: notes.trim(),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* === Identity === */}
      <h3 className={SECTION_HEADER_CLASS}>Identität</h3>

      <div>
        <label className={LABEL_CLASS}>Name *</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. E-Bike Akku"
          required
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Beschreibung</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={INPUT_CLASS}
          rows={2}
          placeholder="Optionale Beschreibung"
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Hersteller</label>
          <input type="text" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className={INPUT_CLASS} placeholder="z.B. Bosch" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Modellbezeichnung</label>
          <input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} className={INPUT_CLASS} placeholder="z.B. PowerTube 625" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Artikelnummer</label>
          <input type="text" value={articleNumber} onChange={(e) => setArticleNumber(e.target.value)} className={INPUT_CLASS} disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>GTIN / EAN</label>
          <input type="text" value={gtin} onChange={(e) => setGtin(e.target.value)} className={INPUT_CLASS} disabled={disabled} />
        </div>
      </div>

      {/* === Cell + chemistry === */}
      <h3 className={SECTION_HEADER_CLASS}>Zelle &amp; Chemie</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Chemie</label>
          <input type="text" value={chemistry} onChange={(e) => setChemistry(e.target.value)} className={INPUT_CLASS} placeholder="z.B. Li-ion, LiFePO4, NiMH" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Zellbezeichnung</label>
          <input type="text" value={cellDesignation} onChange={(e) => setCellDesignation(e.target.value)} className={INPUT_CLASS} placeholder="z.B. INR19/66, 18650" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Zellkonfiguration</label>
          <input type="text" value={cellConfiguration} onChange={(e) => setCellConfiguration(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 6S2P, 13S4P" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Bauform</label>
          <select value={batteryFormFactor} onChange={(e) => setBatteryFormFactor(e.target.value)} className={INPUT_CLASS} disabled={disabled}>
            <option value="">— wählen —</option>
            <option value="pack">Pack</option>
            <option value="single-cell">Einzelzelle</option>
            <option value="integrated">Integriert</option>
            <option value="removable">Wechselakku</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Nennspannung (V)</label>
          <input type="number" step="0.1" min={0} value={nominalVoltageV} onChange={(e) => setNominalVoltageV(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 21.9" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Nennkapazität (mAh)</label>
          <input type="number" min={0} value={nominalCapacityMah} onChange={(e) => setNominalCapacityMah(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 4500" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Akkukapazität (Wh)</label>
          <input type="number" step="0.1" min={0} value={capacityWh} onChange={(e) => setCapacityWh(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 98.55" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Gewicht (g)</label>
          <input type="number" min={0} value={weightGrams} onChange={(e) => setWeightGrams(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 3700" disabled={disabled} />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Tauschbar?</label>
        <div className="flex gap-2">
          {(['unknown', 'yes', 'no'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setReplaceable(opt)}
              disabled={disabled}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                replaceable === opt
                  ? 'bg-blue-500 text-white'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {opt === 'unknown' ? 'unbekannt' : opt === 'yes' ? 'ja' : 'nein'}
            </button>
          ))}
        </div>
      </div>

      {/* === Charge spec === */}
      <h3 className={SECTION_HEADER_CLASS}>Lade-Spec</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Max. Ladespannung (V)</label>
          <input type="number" step="0.1" min={0} value={maxChargeVoltageV} onChange={(e) => setMaxChargeVoltageV(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 21.9" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Max. Ladestrom (A)</label>
          <input type="number" step="0.1" min={0} value={maxChargeCurrentA} onChange={(e) => setMaxChargeCurrentA(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 4.5" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Lade-Temperatur min (°C)</label>
          <input type="number" value={chargeTempMinC} onChange={(e) => setChargeTempMinC(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 0" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Lade-Temperatur max (°C)</label>
          <input type="number" value={chargeTempMaxC} onChange={(e) => setChargeTempMaxC(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 40" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Ladegerät-Modell</label>
          <input type="text" value={chargerModel} onChange={(e) => setChargerModel(e.target.value)} className={INPUT_CLASS} placeholder="z.B. Winbot W3 Dock" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Wirkungsgrad AC→DC (0–1)</label>
          <input type="number" step="0.01" min={0} max={1} value={chargerEfficiency} onChange={(e) => setChargerEfficiency(e.target.value)} className={INPUT_CLASS} placeholder="0.85 (Standard)" disabled={disabled} />
          <p className="text-[11px] text-neutral-500 mt-1">
            Anteil AC-Leistung der real DC im Akku ankommt. Standard 0.85.
          </p>
        </div>
      </div>

      {/* === Provenance === */}
      <h3 className={SECTION_HEADER_CLASS}>Identität &amp; Herkunft</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Seriennummer</label>
          <input type="text" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} className={INPUT_CLASS} disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Produktionsdatum</label>
          <input type="text" value={productionDate} onChange={(e) => setProductionDate(e.target.value)} className={INPUT_CLASS} placeholder="YYYY-MM oder YYYY-MM-DD" disabled={disabled} />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Herkunftsland</label>
        <input type="text" value={countryOfOrigin} onChange={(e) => setCountryOfOrigin(e.target.value)} className={INPUT_CLASS} placeholder="z.B. China, Germany" disabled={disabled} />
      </div>

      <div>
        <label className={LABEL_CLASS}>Zertifizierungen (komma-getrennt)</label>
        <input
          type="text"
          value={certificationsCsv}
          onChange={(e) => setCertificationsCsv(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. UL 62133-2, CE, EAC, PSE"
          disabled={disabled}
        />
      </div>

      {/* === Lifecycle === */}
      <h3 className={SECTION_HEADER_CLASS}>Lifecycle &amp; Garantie</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Kaufdatum</label>
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className={INPUT_CLASS} disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Garantie bis</label>
          <input type="date" value={warrantyUntil} onChange={(e) => setWarrantyUntil(e.target.value)} className={INPUT_CLASS} disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Max. Ladezyklen (Hersteller)</label>
          <input type="number" min={0} value={estimatedCycles} onChange={(e) => setEstimatedCycles(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 500" disabled={disabled} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Garantie-Zyklen</label>
          <input type="number" min={0} value={warrantyCycles} onChange={(e) => setWarrantyCycles(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 300" disabled={disabled} />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>End-of-Life-Kapazität (%)</label>
        <input type="number" min={0} max={100} value={endOfLifeCapacityPct} onChange={(e) => setEndOfLifeCapacityPct(e.target.value)} className={INPUT_CLASS} placeholder="80 (Standard)" disabled={disabled} />
        <p className="text-[11px] text-neutral-500 mt-1">
          Restkapazität-Schwelle ab der der Akku als verbraucht gilt.
        </p>
      </div>

      {/* === Links / commercial === */}
      <h3 className={SECTION_HEADER_CLASS}>Links &amp; kommerziell</h3>

      <div>
        <label className={LABEL_CLASS}>Produkt-Link</label>
        <input type="url" value={productUrl} onChange={(e) => setProductUrl(e.target.value)} className={INPUT_CLASS} placeholder="https://…" disabled={disabled} />
      </div>

      <div>
        <label className={LABEL_CLASS}>Datenblatt / PDF</label>
        <input type="url" value={documentUrl} onChange={(e) => setDocumentUrl(e.target.value)} className={INPUT_CLASS} placeholder="https://…" disabled={disabled} />
      </div>

      <div>
        <label className={LABEL_CLASS}>Preis (EUR)</label>
        <input type="number" step="0.01" min={0} value={priceEur} onChange={(e) => setPriceEur(e.target.value)} className={INPUT_CLASS} placeholder="z.B. 89.99" disabled={disabled} />
      </div>

      {/* === Notes === */}
      <h3 className={SECTION_HEADER_CLASS}>Notizen</h3>

      <div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={INPUT_CLASS}
          rows={3}
          placeholder="Freie Notizen zu diesem Profil…"
          disabled={disabled}
        />
      </div>

      <button
        type="submit"
        disabled={disabled || !name.trim()}
        className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitLabel}
      </button>
    </form>
  );
}
