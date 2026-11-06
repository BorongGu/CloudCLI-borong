import { useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import ModelMenu from '@/shared/ui/ModelMenu';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';

const requests = new Map<LLMProvider, { created: number; promise: Promise<ProviderModelsDefinition> }>();

function loadCatalog(provider: LLMProvider) {
  const cached = requests.get(provider);
  if (cached && Date.now() - cached.created < 30_000) return cached.promise;
  const promise = api.providers.models(provider).then(async response => {
    const body = await response.json() as { success?: boolean; data?: { models?: ProviderModelsDefinition } };
    if (!response.ok || !body.success || !body.data?.models) throw new Error('模型目录读取失败，请重试。');
    return body.data.models;
  }).catch(error => { requests.delete(provider); throw error; });
  requests.set(provider, { created: Date.now(), promise });
  return promise;
}

/** Groups and context transfer use the same model/effort menu and catalog as ordinary chat. */
export function ProviderModelPicker({ provider, model, effort, label, onChange }: {
  provider: LLMProvider; model?: string | null; effort?: string | null; label: string;
  onChange: (model: string, effort: string) => void;
}) {
  // Each picker retains the catalog for its selected harness and exposes loading failures.
  const [catalog, setCatalog] = useState<{ provider: LLMProvider; models?: ProviderModelsDefinition; error?: string }>({ provider });
  // A retry refreshes this picker after a recoverable catalog error.
  const [retry, setRetry] = useState(0);
  const initializedDefault = useRef('');
  useEffect(() => {
    let active = true;
    void loadCatalog(provider).then(models => { if (active) setCatalog({ provider, models }); })
      .catch(error => { if (active) setCatalog({ provider, error: String(error.message) }); });
    return () => { active = false; };
  }, [provider, retry]);
  const models = catalog.provider === provider ? catalog.models : undefined;
  const selected = model || models?.DEFAULT || '';
  const options = models?.OPTIONS || [];
  const selectedOption = options.find(option => option.value === selected);
  const effortOptions = selectedOption?.effort?.values || [];
  useEffect(() => {
    if (model) { initializedDefault.current = ''; return; }
    if (models?.DEFAULT && initializedDefault.current !== `${provider}:${models.DEFAULT}`) {
      initializedDefault.current = `${provider}:${models.DEFAULT}`;
      onChange(models.DEFAULT, effort || 'default');
    }
  }, [provider, model, models, effort, onChange]);

  return <div className="flex min-w-0 items-center gap-2">
    <ModelMenu ariaLabel={label} model={selected || '加载模型…'} modelOptions={options}
      onSelectModel={value => onChange(value, 'default')} modelsLoading={!models && !catalog.error}
      effort={effort || 'default'} effortOptions={effortOptions} onSelectEffort={value => onChange(selected, value)} />
    {catalog.provider === provider && catalog.error && <button type="button" className="text-xs text-amber-600" onClick={() => setRetry(value => value + 1)}>{catalog.error}</button>}
  </div>;
}
