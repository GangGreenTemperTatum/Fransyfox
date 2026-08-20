import type { FrameNode, MessageEventRecord, FrameSeverity } from './types/listener';

export {};

// Frame & Message Map rendering for the Fransyfox panel.
//
// Nodes are frames (identity = real Chrome frameId), laid out as a hierarchy
// from parentFrameId. Edges are aggregated message flows. Message events carry
// both the receiving frame's real frameId and the source/target hop labels, so
// the hops->frameId mapping is derived from traffic and used to resolve edge
// endpoints. Unresolvable sources (cross-window / opaque) collapse into a
// single "external" node so they are still visible.
const mapLog = FransyfoxLogger.scoped('panel-ui-map');

const SVG_NS = 'http://www.w3.org/2000/svg';

const SEVERITY_COLOR: Record<string, string> = {
  high: '#dc2626',
  medium: '#d97706',
  low: '#eab308'
};
const NODE_NEUTRAL = '#475569';
const NODE_ACTIVE = '#2563eb';
const EXTERNAL_ID = -9999;

const NODE_W = 168;
const NODE_H = 50;
const ROW_GAP = 112;
const TOP_PAD = 48;
const SIDE_PAD = 24;

type Point = { x: number; y: number };

type EdgeAgg = {
  source: number;
  target: number;
  count: number;
  crossOrigin: boolean;
  sampleOrigin: string;
  sampleData: string;
};

type RenderOptions = { selectedFrameId?: number | null };

class PanelUIMap {
  private container: HTMLElement | null;
  private selectHandler: ((frameId: number | null) => void) | null;

  constructor() {
    this.container = document.getElementById('map-canvas');
    this.selectHandler = null;
  }

  setSelectHandler(handler: (frameId: number | null) => void): void {
    this.selectHandler = handler;
  }

  private ensureContainer(): HTMLElement | null {
    if (!this.container) {
      this.container = document.getElementById('map-canvas');
    }
    return this.container;
  }

  private static labelFor(frame: FrameNode): string {
    if (frame.origin) {
      try {
        return new URL(frame.origin).host || frame.origin;
      } catch {
        return frame.origin;
      }
    }
    if (frame.url) {
      try {
        return new URL(frame.url).host || frame.url;
      } catch {
        return frame.url;
      }
    }
    return frame.frameId === 0 ? 'top' : `frame ${frame.frameId}`;
  }

  // Build hops -> frameId from events: each event's frameId is the receiving
  // frame, whose hop label is event.targetFrame.
  private static buildHopsToFrameId(messages: MessageEventRecord[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const m of messages) {
      if (typeof m.frameId === 'number' && typeof m.targetFrame === 'string' && m.targetFrame) {
        map.set(m.targetFrame, m.frameId);
      }
    }
    return map;
  }

  private static aggregateEdges(
    messages: MessageEventRecord[],
    hopsToFrameId: Map<string, number>,
    frameOrigin: Map<number, string>
  ): EdgeAgg[] {
    const byKey = new Map<string, EdgeAgg>();
    for (const m of messages) {
      const target = typeof m.frameId === 'number' ? m.frameId : null;
      if (target === null) continue;
      const srcHops = typeof m.sourceFrame === 'string' ? m.sourceFrame : '';
      let source = srcHops && hopsToFrameId.has(srcHops) ? (hopsToFrameId.get(srcHops) as number) : EXTERNAL_ID;
      if (source === target && srcHops && srcHops !== m.targetFrame) {
        // Same resolved frame but distinct hop label: keep as external to avoid
        // a misleading self-loop.
        source = EXTERNAL_ID;
      }
      const key = `${source}->${target}`;
      const origin = typeof m.origin === 'string' ? m.origin : '';
      const targetOrigin = frameOrigin.get(target) || '';
      const crossOrigin = !!origin && !!targetOrigin && origin !== targetOrigin;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (crossOrigin) existing.crossOrigin = true;
      } else {
        byKey.set(key, {
          source,
          target,
          count: 1,
          crossOrigin,
          sampleOrigin: origin,
          sampleData: typeof m.dataText === 'string' ? m.dataText.slice(0, 120) : ''
        });
      }
    }
    return Array.from(byKey.values());
  }

  // Depth = length of the parentFrameId chain to a root. Cycle/orphan safe.
  private static computeDepths(frames: FrameNode[]): Map<number, number> {
    const byId = new Map<number, FrameNode>();
    for (const f of frames) byId.set(f.frameId, f);
    const depth = new Map<number, number>();
    for (const f of frames) {
      let d = 0;
      let cur: FrameNode | undefined = f;
      const seen = new Set<number>();
      while (cur && cur.parentFrameId >= 0 && byId.has(cur.parentFrameId) && !seen.has(cur.frameId)) {
        seen.add(cur.frameId);
        d += 1;
        cur = byId.get(cur.parentFrameId);
        if (d > 64) break;
      }
      depth.set(f.frameId, d);
    }
    return depth;
  }

  render(frames: FrameNode[], messages: MessageEventRecord[], options?: RenderOptions): void {
    const container = this.ensureContainer();
    if (!container) {
      mapLog.warn('Fransyfox: Map canvas element not found');
      return;
    }
    container.textContent = '';

    if (!frames || frames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'map-empty';
      empty.textContent =
        'No frames detected yet. Interact with the page (or reload it) so listeners and postMessages are captured.';
      container.appendChild(empty);
      return;
    }

    const safeMessages = Array.isArray(messages) ? messages : [];
    const frameOrigin = new Map<number, string>();
    for (const f of frames) frameOrigin.set(f.frameId, f.origin || '');
    const hopsToFrameId = PanelUIMap.buildHopsToFrameId(safeMessages);
    const edges = PanelUIMap.aggregateEdges(safeMessages, hopsToFrameId, frameOrigin);
    const hasExternal = edges.some((e) => e.source === EXTERNAL_ID);
    const depths = PanelUIMap.computeDepths(frames);

    // Group nodes by depth row.
    const rows = new Map<number, FrameNode[]>();
    let maxDepth = 0;
    for (const f of frames) {
      const d = depths.get(f.frameId) || 0;
      maxDepth = Math.max(maxDepth, d);
      const row = rows.get(d) || [];
      row.push(f);
      rows.set(d, row);
    }
    for (const [, row] of rows) {
      row.sort((a, b) => a.frameId - b.frameId);
    }

    const widestRow = Math.max(1, ...Array.from(rows.values()).map((r) => r.length), hasExternal ? 1 : 0);
    const width = Math.max(container.clientWidth || 640, widestRow * (NODE_W + 36) + SIDE_PAD * 2);
    const externalRows = hasExternal ? 1 : 0;
    const height = TOP_PAD + (maxDepth + 1) * ROW_GAP + externalRows * ROW_GAP;

    const pos = new Map<number, Point>();
    for (const [d, row] of rows) {
      const n = row.length;
      row.forEach((f, i) => {
        const x = ((i + 1) / (n + 1)) * width;
        const y = TOP_PAD + d * ROW_GAP;
        pos.set(f.frameId, { x, y });
      });
    }
    if (hasExternal) {
      pos.set(EXTERNAL_ID, { x: width / 2, y: TOP_PAD + (maxDepth + 1) * ROW_GAP });
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    svg.appendChild(PanelUIMap.buildDefs());

    // Edges first so nodes paint on top.
    const maxCount = Math.max(1, ...edges.map((e) => e.count));
    for (const edge of edges) {
      const s = pos.get(edge.source);
      const t = pos.get(edge.target);
      if (!s || !t) continue;
      svg.appendChild(PanelUIMap.buildEdge(s, t, edge, maxCount));
    }

    // Nodes.
    for (const f of frames) {
      const p = pos.get(f.frameId);
      if (!p) continue;
      const selected = options?.selectedFrameId != null && options.selectedFrameId === f.frameId;
      svg.appendChild(this.buildNode(f, p, selected));
    }
    if (hasExternal) {
      const p = pos.get(EXTERNAL_ID);
      if (p) svg.appendChild(PanelUIMap.buildExternalNode(p));
    }

    container.appendChild(svg);
    container.appendChild(PanelUIMap.buildLegend());
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
    defs.appendChild(make('map-arrow-same', '#64748b'));
    defs.appendChild(make('map-arrow-cross', '#dc2626'));
    return defs;
  }

  private static buildEdge(s: Point, t: Point, edge: EdgeAgg, maxCount: number): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    const sy = s.y + NODE_H / 2;
    const ty = t.y - NODE_H / 2;
    const midY = (sy + ty) / 2;
    const path = document.createElementNS(SVG_NS, 'path');
    // Cubic bezier with vertical control points for a clean tree-ish flow.
    const d = `M ${s.x} ${sy} C ${s.x} ${midY}, ${t.x} ${midY}, ${t.x} ${ty}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    const color = edge.crossOrigin ? '#dc2626' : '#94a3b8';
    path.setAttribute('stroke', color);
    const w = 1 + Math.round((edge.count / maxCount) * 4);
    path.setAttribute('stroke-width', String(w));
    path.setAttribute('opacity', edge.crossOrigin ? '0.85' : '0.6');
    path.setAttribute('marker-end', edge.crossOrigin ? 'url(#map-arrow-cross)' : 'url(#map-arrow-same)');
    const title = document.createElementNS(SVG_NS, 'title');
    const originLabel = edge.sampleOrigin ? `\norigin: ${edge.sampleOrigin}` : '';
    const dataLabel = edge.sampleData ? `\nsample: ${edge.sampleData}` : '';
    title.textContent = `${edge.count} message${edge.count === 1 ? '' : 's'}${edge.crossOrigin ? ' (cross-origin)' : ''}${originLabel}${dataLabel}`;
    path.appendChild(title);
    g.appendChild(path);

    // Count label at the midpoint.
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String((s.x + t.x) / 2));
    label.setAttribute('y', String(midY - 2));
    label.setAttribute('class', 'map-edge-label');
    label.setAttribute('text-anchor', 'middle');
    label.textContent = String(edge.count);
    g.appendChild(label);
    return g;
  }

  private buildNode(frame: FrameNode, p: Point, selected: boolean): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'map-node');
    g.setAttribute('transform', `translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`);
    g.style.cursor = 'pointer';

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '8');
    rect.setAttribute('fill', '#ffffff');
    const border = PanelUIMap.borderColor(frame, selected);
    rect.setAttribute('stroke', border);
    rect.setAttribute('stroke-width', selected ? '3' : '2');
    g.appendChild(rect);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', '12');
    label.setAttribute('y', '20');
    label.setAttribute('class', 'map-node-label');
    label.textContent = PanelUIMap.truncate(PanelUIMap.labelFor(frame), 22);
    g.appendChild(label);

    const sub = document.createElementNS(SVG_NS, 'text');
    sub.setAttribute('x', '12');
    sub.setAttribute('y', '38');
    sub.setAttribute('class', 'map-node-sub');
    const sevText = frame.maxSeverity ? ` · ${frame.maxSeverity}` : '';
    sub.textContent = `${frame.frameId === 0 ? 'top' : 'frame ' + frame.frameId} · ${frame.listenerCount} listener${frame.listenerCount === 1 ? '' : 's'}${sevText}`;
    g.appendChild(sub);

    if (frame.listenerCount > 0) {
      const badge = document.createElementNS(SVG_NS, 'circle');
      badge.setAttribute('cx', String(NODE_W - 16));
      badge.setAttribute('cy', '16');
      badge.setAttribute('r', '10');
      badge.setAttribute('fill', frame.maxSeverity ? SEVERITY_COLOR[frame.maxSeverity] || NODE_NEUTRAL : NODE_NEUTRAL);
      g.appendChild(badge);
      const badgeText = document.createElementNS(SVG_NS, 'text');
      badgeText.setAttribute('x', String(NODE_W - 16));
      badgeText.setAttribute('y', '20');
      badgeText.setAttribute('text-anchor', 'middle');
      badgeText.setAttribute('class', 'map-node-badge');
      badgeText.textContent = String(frame.listenerCount);
      g.appendChild(badgeText);
    }

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${frame.url || frame.origin || 'unknown frame'}\nframeId ${frame.frameId} · ${frame.listenerCount} listener(s)`;
    g.appendChild(title);

    g.addEventListener('click', () => {
      if (this.selectHandler) this.selectHandler(frame.frameId);
    });
    return g;
  }

  private static buildExternalNode(p: Point): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '8');
    rect.setAttribute('fill', '#f1f5f9');
    rect.setAttribute('stroke', '#94a3b8');
    rect.setAttribute('stroke-width', '2');
    rect.setAttribute('stroke-dasharray', '5 4');
    g.appendChild(rect);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(NODE_W / 2));
    label.setAttribute('y', '24');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'map-node-label');
    label.textContent = 'external / unresolved';
    g.appendChild(label);
    const sub = document.createElementNS(SVG_NS, 'text');
    sub.setAttribute('x', String(NODE_W / 2));
    sub.setAttribute('y', '40');
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('class', 'map-node-sub');
    sub.textContent = 'cross-window senders';
    g.appendChild(sub);
    return g;
  }

  private static borderColor(frame: FrameNode, selected: boolean): string {
    if (selected) return NODE_ACTIVE;
    if (frame.maxSeverity) return SEVERITY_COLOR[frame.maxSeverity] || NODE_NEUTRAL;
    return NODE_NEUTRAL;
  }

  private static truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  private static buildLegend(): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'map-legend';
    const items: Array<[string, string]> = [
      ['#94a3b8', 'same-origin flow'],
      ['#dc2626', 'cross-origin flow'],
      [SEVERITY_COLOR.high, 'high-severity finding'],
      [SEVERITY_COLOR.medium, 'medium-severity finding']
    ];
    for (const [color, text] of items) {
      const item = document.createElement('span');
      item.className = 'map-legend-item';
      const dot = document.createElement('span');
      dot.className = 'map-legend-dot';
      dot.style.background = color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(text));
      legend.appendChild(item);
    }
    const hint = document.createElement('span');
    hint.className = 'map-legend-hint';
    hint.textContent = 'Click a frame to filter Messages to it.';
    legend.appendChild(hint);
    return legend;
  }
}

type PanelUIMapType = typeof PanelUIMap;
const globalObj = globalThis as typeof globalThis & { PanelUIMap?: PanelUIMapType };
globalObj.PanelUIMap = PanelUIMap;

// Reference imported type to satisfy the linter when unused in value position.
export type { FrameSeverity };
