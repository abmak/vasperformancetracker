import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, MoveHorizontal, ImageOff } from 'lucide-react';
import { request } from '../context/AuthContext';

/**
 * Slider puzzle captcha.
 *
 * The server sends a scene with a piece-shaped hole plus the loose piece;
 * the user drags it horizontally until it fills the hole. The answer (X
 * offset) is submitted with the login request and verified server-side —
 * the correct position never leaves the server.
 *
 * The current answer is written into `answerRef.current` as
 * { captcha_id, captcha_x } so the parent can read it at submit time
 * without re-render loops. Parent bumps `refreshKey` to force a new puzzle
 * (e.g. after an expired/failed attempt).
 */

const PIECE = 52; // matches the server-side piece size

export default function PuzzleCaptcha({ answerRef, refreshKey }) {
  const [challenge, setChallenge] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef(null);

  const load = useCallback(async () => {
    setLoadError(false);
    setX(0);
    setChallenge(null);
    try {
      setChallenge(await request('/auth/captcha'));
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Publish the answer for the parent to read on submit.
  useEffect(() => {
    if (!answerRef) return;
    answerRef.current = challenge ? { captcha_id: challenge.id, captcha_x: Math.round(x) } : null;
  }, [challenge, x, answerRef]);

  const width = challenge ? challenge.width : 0;

  const clamp = (v) => Math.max(0, Math.min(width - PIECE, v));

  const pointToX = (clientX) => {
    const track = trackRef.current;
    if (!track || !width) return x;
    const rect = track.getBoundingClientRect();
    const usable = Math.max(1, rect.width - PIECE);
    const ratio = (clientX - rect.left - PIECE / 2) / usable;
    return clamp(Math.round(ratio * (width - PIECE)));
  };

  const startDrag = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    setDragging(true);
    setX(pointToX(e.clientX));
  };
  const onMove = (e) => { if (dragging) setX(pointToX(e.clientX)); };
  const endDrag = () => setDragging(false);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
          Security check
        </label>
        <button
          type="button"
          onClick={load}
          title="New puzzle"
          className="inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-green-700 transition"
        >
          <RefreshCw size={13} /> New puzzle
        </button>
      </div>

      {loadError && (
        <button
          type="button"
          onClick={load}
          className="w-full h-[160px] flex flex-col items-center justify-center gap-2 bg-gray-50 border border-gray-200 rounded-xl text-gray-500 hover:bg-gray-100 transition"
        >
          <ImageOff size={20} />
          <span className="text-sm font-medium">Could not load puzzle — tap to retry</span>
        </button>
      )}

      {challenge && (
        <>
          <div
            className="relative mx-auto rounded-lg overflow-hidden border border-gray-200"
            style={{ width, height: challenge.height }}
          >
            <img
              src={challenge.bg}
              alt="captcha puzzle"
              width={width}
              height={challenge.height}
              draggable={false}
              className="block"
            />
            <img
              src={challenge.piece}
              alt=""
              draggable={false}
              onPointerDown={startDrag}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                position: 'absolute',
                left: x,
                top: challenge.piece_y,
                width: PIECE,
                height: PIECE,
                cursor: dragging ? 'grabbing' : 'grab',
                boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                borderRadius: 4,
                touchAction: 'none',
              }}
            />
          </div>

          <div
            ref={trackRef}
            onPointerDown={startDrag}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="relative mx-auto mt-2 rounded-full bg-gray-100 border border-gray-200 overflow-hidden"
            style={{ width, height: 40, touchAction: 'none' }}
          >
            <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-[11px] text-gray-400 font-medium pointer-events-none">
              Slide to solve
            </span>
            <div
              className="absolute top-0 flex items-center justify-center bg-white border border-gray-200 rounded-full shadow-md"
              style={{ width: PIECE, height: 40, left: x, cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
            >
              <MoveHorizontal size={16} className="text-green-600" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
