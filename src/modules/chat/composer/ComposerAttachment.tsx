import { useEffect, useState } from 'react';
import { Check, FileIcon, Loader2, RotateCw, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatAttachmentProgress } from '@/shared/types';

import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';

type ComposerAttachmentProps = {
  file: File;
  onRemove: () => void;
  error?: string;
  progress?: ChatAttachmentProgress;
  onRetry?: () => void;
  disabled?: boolean;
};

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Rendered by chat's ChatComposer for each pending attachment, showing its
 * thumbnail or file chip, upload progress and remove control.
 */
const ComposerAttachment = ({ file, onRemove, error, progress, onRetry, disabled }: ComposerAttachmentProps) => {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative max-w-full">
      {isImage ? (
        <button
          type="button"
          onClick={() => preview && setExpanded(true)}
          aria-label={`Expand ${file.name}`}
          className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        >
          {preview
            ? <img src={preview} alt={file.name} className="h-20 w-20 cursor-zoom-in object-cover" />
            : <div className="h-20 w-20 animate-pulse bg-muted" />}
        </button>
      ) : (
        <div className="flex h-20 w-56 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-background/80 px-3 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileIcon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
        </div>
      )}
      {(progress || error) && <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground" role="status" data-upload-phase={progress?.phase} title={progress?.error || error}>
        {progress?.phase === 'error' || error ? <button type="button" disabled={disabled} onClick={onRetry} className="flex items-center gap-1 text-primary" aria-label={t('input.retryAttachment', { name: file.name, defaultValue: 'Retry {{name}}' })}><RotateCw className="h-3 w-3" />{t('input.attachmentRetry', { defaultValue: 'Retry' })}</button>
          : progress?.phase === 'ready' ? <><Check className="h-3 w-3 text-primary" />{t('input.attachmentReady', { defaultValue: 'Ready' })}</>
          : <><Loader2 className="h-3 w-3 animate-spin" />{progress?.phase === 'preparing' ? t('input.attachmentPreparing', { defaultValue: 'Preparing' }) : progress?.percent === 99 ? t('input.attachmentConfirming', { defaultValue: 'Confirming' }) : `${progress?.percent || 0}%`}</>}
      </div>}
      {progress?.phase === 'uploading' && <progress className="mt-1 block h-0.5 w-full accent-[hsl(var(--primary))]" value={progress.percent} max={100} aria-label={t('input.attachmentProgress', { name: file.name, defaultValue: '{{name}} upload progress' })} />}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={`Remove ${file.name}`}
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
      {expanded && preview && (
        <ImageLightbox src={preview} alt={file.name} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
};

export default ComposerAttachment;
