import { useEffect, useRef, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { renderPnlCard, type PnlCardData } from '../services/pnlCard';

export default function PnlShareCard({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    setFile(null); setError('');
    let active = true;
    void renderPnlCard(canvas.current!, data).then((blob) => {
      if (active) setFile(new File([blob], `hopr-${data.symbol.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'position'}-pnl.png`, { type: 'image/png' }));
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [data]);
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(file); const a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const share = async () => {
    if (!file) return;
    if (!navigator.canShare?.({ files: [file] })) { download(); return; }
    try { await navigator.share({ files: [file], title: `${data.symbol} · HOPR PnL` }); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError('Sharing was not available. Use Download PNG instead.'); }
  };
  return <dialog ref={dialog} onCancel={onClose} className="m-auto w-[min(940px,94vw)] rounded-2xl border border-gray-700 bg-gray-950 p-4 text-white backdrop:bg-black/80" aria-labelledby="pnl-card-title">
    <div className="mb-3 flex items-center justify-between"><h2 id="pnl-card-title" className="font-semibold">Your HOPR PnL card</h2><button aria-label="Close PnL card" onClick={onClose} className="rounded-lg p-2 hover:bg-gray-800"><X size={18} /></button></div>
    <canvas ref={canvas} className="aspect-[8/5] w-full rounded-xl" role="img" aria-label={`${data.symbol}: estimated PnL ${data.pnlPercent.toFixed(2)} percent`} />
    <p className="mt-3 text-xs text-gray-400">Position estimate from recorded activity and the current wallet balance. Your wallet address is excluded.</p>
    {error && <p role="alert" className="mt-2 text-sm text-amber-400">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2"><button disabled={!file} onClick={download} className="flex items-center gap-2 rounded-xl bg-gray-800 px-4 py-2 text-sm disabled:opacity-40"><Download size={16} />Download PNG</button><button disabled={!file} onClick={() => void share()} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm disabled:opacity-40"><Share2 size={16} />Share card</button></div>
  </dialog>;
}
