'use client';

import { useState } from 'react';

export type ProfileFormValues = {
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

export function ProfileForm({
  initialValues,
  onSubmit,
  submitLabel = 'Speichern',
  disabled,
}: ProfileFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [manufacturer, setManufacturer] = useState(initialValues?.manufacturer ?? '');
  const [modelName, setModelName] = useState(initialValues?.modelName ?? '');
  const [articleNumber, setArticleNumber] = useState(initialValues?.articleNumber ?? '');
  const [gtin, setGtin] = useState(initialValues?.gtin ?? '');
  const [capacityWh, setCapacityWh] = useState<string>(
    initialValues?.capacityWh != null ? String(initialValues.capacityWh) : ''
  );
  const [weightGrams, setWeightGrams] = useState<string>(
    initialValues?.weightGrams != null ? String(initialValues.weightGrams) : ''
  );
  const [purchaseDate, setPurchaseDate] = useState(initialValues?.purchaseDate ?? '');
  const [estimatedCycles, setEstimatedCycles] = useState<string>(
    initialValues?.estimatedCycles != null ? String(initialValues.estimatedCycles) : ''
  );
  const [productUrl, setProductUrl] = useState(initialValues?.productUrl ?? '');
  const [documentUrl, setDocumentUrl] = useState(initialValues?.documentUrl ?? '');
  const [priceEur, setPriceEur] = useState<string>(
    initialValues?.priceEur != null ? String(initialValues.priceEur) : ''
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

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
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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

      <div>
        <label className={LABEL_CLASS}>Hersteller</label>
        <input
          type="text"
          value={manufacturer}
          onChange={(e) => setManufacturer(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. Bosch"
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Modellbezeichnung</label>
        <input
          type="text"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. PowerTube 625"
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLASS}>Artikelnummer</label>
          <input
            type="text"
            value={articleNumber}
            onChange={(e) => setArticleNumber(e.target.value)}
            className={INPUT_CLASS}
            placeholder="z.B. 0 275 007 556"
            disabled={disabled}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>GTIN / EAN</label>
          <input
            type="text"
            value={gtin}
            onChange={(e) => setGtin(e.target.value)}
            className={INPUT_CLASS}
            placeholder="z.B. 4059952527659"
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Akkukapazität (Wh)</label>
        <input
          type="number"
          step="0.1"
          value={capacityWh}
          onChange={(e) => setCapacityWh(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. 625"
          min={0}
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Gewicht (Gramm)</label>
        <input
          type="number"
          value={weightGrams}
          onChange={(e) => setWeightGrams(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. 3700"
          min={0}
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Kaufdatum</label>
        <input
          type="date"
          value={purchaseDate}
          onChange={(e) => setPurchaseDate(e.target.value)}
          className={INPUT_CLASS}
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Max. Ladezyklen (Herstellerangabe)</label>
        <input
          type="number"
          value={estimatedCycles}
          onChange={(e) => setEstimatedCycles(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. 500"
          min={0}
          disabled={disabled}
        />
        <p className="text-[11px] text-neutral-500 mt-1">
          Zyklen bis spürbare Degradation laut Hersteller. Verbrauchte Zyklen werden aus der Session-Historie live berechnet.
        </p>
      </div>

      <div>
        <label className={LABEL_CLASS}>Produkt-Link</label>
        <input
          type="url"
          value={productUrl}
          onChange={(e) => setProductUrl(e.target.value)}
          className={INPUT_CLASS}
          placeholder="https://www.example.com/produkt"
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Datenblatt / PDF</label>
        <input
          type="url"
          value={documentUrl}
          onChange={(e) => setDocumentUrl(e.target.value)}
          className={INPUT_CLASS}
          placeholder="https://www.example.com/datenblatt.pdf"
          disabled={disabled}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Preis (EUR)</label>
        <input
          type="number"
          step="0.01"
          value={priceEur}
          onChange={(e) => setPriceEur(e.target.value)}
          className={INPUT_CLASS}
          placeholder="z.B. 89.99"
          min={0}
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
