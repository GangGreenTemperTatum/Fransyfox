import type { FrameNode, MessageEventRecord } from './types/listener';

export {};

// Sequence / timeline view for the Fransyfox panel.
//
// Frames are vertical lanes; time flows top-to-bottom. Each captured message is
// a horizontal arrow from its source lane to its target lane at its time row.
// Useful for reading handshakes (OAuth popups, payment iframes, SDK init).
const timelineLog = FransyfoxLogger.scoped('panel-ui-timeline');

const SVG_NS = 'http://www.w3.org/2000/svg';
const EXTERNAL_ID = -9999;
const LANE_GAP = 150;
const LANE_TOP = 56;
const ROW_GAP = 34;
const ROW_TOP = LANE_TOP + 24;
const LEFT_PAD = 24;
const MAX_ROWS = 400;

type Lane = { id: number; label: string; x: number };
type RenderOptions = { highlightId?: number | null };

class PanelUITimeline {
  private container: HTMLElement | null;
  private selectHandler: ((messageId: number) => void) | null;

  constructor() {
    this.container = document.getElementById('timeline-canvas');
    this.selectHandler = null;
  }

  setSelectHandler(handler: (messageId: number) => void): void {
    this.selectHandler = handler;
  }

  private ensureContainer(): HTMLElement | null {
    if (!this.container) {
      this.container = document.getElementById('timeline-canvas');
    }
    return this.container;
  }

  private static laneLabel(frame: FrameNode | undefined, id: number): string {
    if (id === EXTERNAL_ID) return 'external';
    if (!frame) return id === 0 ? 'top' : `frame ${id}`;
    const host = frame.origin || frame.url || '';
    if (host) {
      try {
        return new URL(host).host || (id === 0 ? 'top' : `frame ${id}`);
      } catch {
        return host;
      }
    }
    return id === 0 ? 'top' : `frame ${id}`;
  }

  render(frames: FrameNode[], messages: MessageEventRecord[], options?: RenderOptions): void {
    const container = this.ensureContainer();
    if (!container) {
      timelineLog.warn('Fransyfox: Timeline canvas element not found');
      return;
    }
    container.textContent = '';

    const safeMessages = Array.isArray(messages) ? messages.slice() : [];
    if (safeMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'map-empty';
      empty.textContent = 'No messages captured yet. Interact with the page to record postMessage traffic.';
      container.appendChild(empty);
      return;
    }

    // hops -> frameId from events (event.frameId is the receiving frame).
    const hopsToFrameId = new Map<string, number>();
    for (const m of safeMessages) {
      if (typeof m.frameId === 'number' && typeof m.targetFrame === 'string' && m.targetFrame) {
        hopsToFrameId.set(m.targetFrame, m.frameId);
      }
    }
    const frameById = new Map<number, FrameNode>();
    for (const f of frames) frameById.set(f.frameId, f);

    // Sort ascending by time so the diagram reads top-down chronologically.
    safeMessages.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    let rows = safeMessages;
    let truncated = 0;
    if (rows.length > MAX_ROWS) {
      truncated = rows.length - MAX_ROWS;
      rows = rows.slice(rows.length - MAX_ROWS);
    }

    // Resolve each row to source/target lane ids, collecting lane order.
    const laneOrder: number[] = [];
    const seenLane = new Set<number>();
    const addLane = (id: number) => {
      if (!seenLane.has(id)) {
        seenLane.add(id);
        laneOrder.push(id);
      }
    };
    type Row = { id: number | null; source: number; target: number; origin: string; data: string; crossOrigin: boolean };
    const resolved: Row[] = [];
    for (const m of rows) {
      const target = typeof m.frameId === 'number' ? m.frameId : EXTERNAL_ID;
      const srcHops = typeof m.sourceFrame === 'string' ? m.sourceFrame : '';
      let source = srcHops && hopsToFrameId.has(srcHops) ? (hopsToFrameId.get(srcHops) as number) : EXTERNAL_ID;
      if (source === target && srcHops && srcHops !== m.targetFrame) source = EXTERNAL_ID;
      addLane(source);
      addLane(target);
      const origin = typeof m.origin === 'string' ? m.origin : '';
      const targetOrigin = frameById.get(target)?.origin || '';
      resolved.push({
        id: typeof m.id === 'number' ? m.id : null,
        source,
        target,
        origin,
        data: typeof m.dataText === 'string' ? m.dataText.slice(0, 80) : '',
        crossOrigin: !!origin && !!targetOrigin && origin !== targetOrigin
      });
    }

    // Order lanes: real frames by frameId, external last.
    laneOrder.sort((a, b) => {
      if (a === EXTERNAL_ID) return 1;
      if (b === EXTERNAL_ID) return -1;
      return a - b;
    });
    const lanes: Lane[] = laneOrder.map((id, i) => ({
      id,
      label: PanelUITimeline.laneLabel(frameById.get(id), id),
      x: LEFT_PAD + 60 + i * LANE_GAP
    }));
    const laneX = new Map<number, number>();
    for (const lane of lanes) laneX.set(lane.id, lane.x);

    const width = Math.max(container.clientWidth || 640, LEFT_PAD * 2 + lanes.length * LANE_GAP);
    const height = ROW_TOP + resolved.length * ROW_GAP + 24;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.appendChild(PanelUITimeline.buildDefs());

    // Lane lines + headers.
    for (const lane of lanes) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(lane.x));
      line.setAttribute('y1', String(LANE_TOP));
      line.setAttribute('x2', String(lane.x));
      line.setAttribute('y2', String(height - 12));
      line.setAttribute('stroke', '#e2e8f0');
      line.setAttribute('stroke-width', '2');
      svg.appendChild(line);

      const header = document.createElementNS(SVG_NS, 'text');
      header.setAttribute('x', String(lane.x));
      header.setAttribute('y', String(LANE_TOP - 28));
      header.setAttribute('text-anchor', 'middle');
      header.setAttribute('class', 'map-node-label');
      header.textContent = lane.label.length > 18 ? lane.label.slice(0, 17) + '…' : lane.label;
      const headerTitle = document.createElementNS(SVG_NS, 'title');
      headerTitle.textContent = lane.id === EXTERNAL_ID ? 'external / cross-window senders' : `frameId ${lane.id}`;
      header.appendChild(headerTitle);
      svg.appendChild(header);
    }

    // Message arrows.
    const highlightId = options && typeof options.highlightId === 'number' ? options.highlightId : null;
    let highlightY: number | null = null;
    resolved.forEach((row, i) => {
      const y = ROW_TOP + i * ROW_GAP;
      const sx = laneX.get(row.source);
      const tx = laneX.get(row.target);
      if (sx === undefined || tx === undefined) return;
      const isHighlight = highlightId !== null && row.id === highlightId;
      if (isHighlight) highlightY = y;
      svg.appendChild(this.buildArrow(width, sx, tx, y, row, isHighlight));
    });

    container.appendChild(svg);

    if (truncated > 0) {
      const note = document.createElement('div');
      note.className = 'map-legend';
      note.textContent = `Showing the most recent ${MAX_ROWS} of ${MAX_ROWS + truncated} messages.`;
      container.appendChild(note);
    }

    // Scroll the highlighted row into view within the scrollable panel.
    if (highlightY !== null) {
      const scroller = container.closest<HTMLElement>('.map-panel') || container.parentElement;
      if (scroller) {
        const targetY = Math.max(0, highlightY - scroller.clientHeight / 2);
        scroller.scrollTop = targetY;
      }
    }
  }

  private static buildDefs(): SVGDefsElement {
    const defs = document.createElementNS(SVG_NS, 'defs');
    const make = (id: string, color: string) => {
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('fill', color);
      marker.appendChild(path);
      return marker;
    };
    defs.appendChild(make('tl-arrow-same', '#64748b'));
    defs.appendChild(make('tl-arrow-cross', '#dc2626'));
    return defs;
  }

  private buildArrow(
    width: number,
    sx: number,
    tx: number,
    y: number,
    row: { id: number | null; source: number; target: number; origin: string; data: string; crossOrigin: boolean },
    highlighted: boolean
  ): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', highlighted ? 'timeline-row timeline-row-flash' : 'timeline-row');
    const color = row.crossOrigin ? '#dc2626' : '#94a3b8';

    // Full-width transparent hit area so the whole row is clickable.
    const hit = document.createElementNS(SVG_NS, 'rect');
    hit.setAttribute('x', '0');
    hit.setAttribute('y', String(y - ROW_GAP / 2));
    hit.setAttribute('width', String(width));
    hit.setAttribute('height', String(ROW_GAP));
    hit.setAttribute('fill', highlighted ? 'rgba(37,99,235,0.10)' : 'transparent');
    if (row.id !== null) {
      g.style.cursor = 'pointer';
      const id = row.id;
      g.addEventListener('click', () => {
        if (this.selectHandler) this.selectHandler(id);
      });
    }
    g.appendChild(hit);

    // Self-message (same lane): draw a small loop marker.
    if (sx === tx) {
      const loop = document.createElementNS(SVG_NS, 'path');
      loop.setAttribute('d', `M ${sx} ${y} c 26 -8, 26 16, 0 8`);
      loop.setAttribute('fill', 'none');
      loop.setAttribute('stroke', color);
      loop.setAttribute('stroke-width', '1.5');
      loop.setAttribute('marker-end', row.crossOrigin ? 'url(#tl-arrow-cross)' : 'url(#tl-arrow-same)');
      g.appendChild(loop);
    } else {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(sx));
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(tx));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', row.crossOrigin ? 'url(#tl-arrow-cross)' : 'url(#tl-arrow-same)');
      g.appendChild(line);
    }

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String((sx + tx) / 2));
    label.setAttribute('y', String(y - 5));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'map-edge-label');
    label.textContent = row.data ? (row.data.length > 40 ? row.data.slice(0, 39) + '…' : row.data) : '(message)';
    g.appendChild(label);

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${row.origin ? 'origin: ' + row.origin + '\n' : ''}${row.crossOrigin ? '(cross-origin)\n' : ''}${row.data}`;
    g.appendChild(title);
    return g;
  }
}

type PanelUITimelineType = typeof PanelUITimeline;
const globalObj = globalThis as typeof globalThis & { PanelUITimeline?: PanelUITimelineType };
globalObj.PanelUITimeline = PanelUITimeline;
