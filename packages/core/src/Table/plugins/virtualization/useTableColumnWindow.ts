// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file useTableColumnWindow.ts
 * @input Admitted column pitches and keys, pinned run sizes, the seed and shared inline geometry
 * @output Stable column and spacer segments, one retained focused column and the inline anchor
 * @position Table pre-cell column planner; reads the parent's viewport, owns no observer
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type RefObject,
} from 'react';
import {useIsomorphicLayoutEffect} from '../../../hooks/useIsomorphicLayoutEffect';
import {useDevWarningPerMessage} from '../../../hooks/useDevWarning';
import {
  moveFocusLeftBehind,
  noteFocusWithin,
  type FocusWithin,
} from '../../../utils/focusReturn';
import {useInteractionModalityTrackingFor} from '../../../utils/interactionModality';
import {
  calculateVariableListRange,
  createListWindowSegments,
  isPositiveFinite,
  reconcileListAnchor,
} from '../../../utils/listWindow';
import {
  getTableVirtualizationConfig,
  type TableVirtualizationCapability,
} from './useTableRowsVirtualization';
import {
  getTableColumnsVirtualizationConfig,
  type UseTableColumnsVirtualizationConfig,
} from './useTableColumnsVirtualization';

export type TableColumnSegment =
  | {type: 'columns'; start: number; end: number}
  | {type: 'gap'; start: number; end: number; width: number};

export interface TableInlineGeometry {
  isMeasured: boolean;
  viewportWidth?: number;
  scrollLeft?: number;
}
export interface TableInlineGeometrySource {
  subscribeInline: (onChange: () => void) => () => void;
  getSnapshot: () => TableInlineGeometry;
  getServerSnapshot: () => TableInlineGeometry;
}

export interface ResolvedTableVirtualization {
  /** The rows capability, passed on to the row planner unchanged. */
  rows?: TableVirtualizationCapability;
  columns?: Readonly<UseTableColumnsVirtualizationConfig>;
  /** Why the value cannot window at all. */
  invalidReason?: string;
}

/** One capability, or a list with at most one per axis. */
export function resolveTableVirtualization(
  value: unknown,
): ResolvedTableVirtualization {
  if (value == null) {
    return {};
  }
  const isList = Array.isArray(value);
  let rows: TableVirtualizationCapability | undefined;
  let columns: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
  for (const item of isList ? (value as unknown[]) : [value]) {
    const columnsConfig = getTableColumnsVirtualizationConfig(item);
    if (getTableVirtualizationConfig(item) != null) {
      if (rows != null) {
        return {
          invalidReason:
            'a virtualization list holds more than one rows capability',
        };
      }
      rows = item as TableVirtualizationCapability;
    } else if (columnsConfig != null) {
      if (columns != null) {
        return {
          invalidReason:
            'a virtualization list holds more than one columns capability',
        };
      }
      columns = columnsConfig;
    } else {
      return {
        invalidReason: isList
          ? 'a virtualization list holds a value that is not a windowing capability'
          : 'virtualization is not a value from useTableRowsVirtualization or useTableColumnsVirtualization',
      };
    }
  }
  return {rows, columns};
}

export interface UseTableColumnWindowOptions {
  config: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
  isAdmitted: boolean;
  /** The pitch of each column, in full-table order. */
  widths: ReadonlyArray<number>;
  /** Columns in the pinned start run, from the first column. */
  startCount: number;
  /** Columns in the pinned end run, through the last column. */
  endCount: number;
  /** Column keys in full-table order: focus and the anchor follow keys. */
  columnKeys: ReadonlyArray<string>;
  table: RefObject<HTMLTableElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  geometry: TableInlineGeometrySource;
}
export interface TableColumnWindowResult {
  segments: ReadonlyArray<TableColumnSegment>;
  /** True while at least one column is not mounted. */
  isWindowed: boolean;
  /** True while column windowing is admitted, so focus is tracked. */
  isActive: boolean;
  onFocus: (event: FocusEvent<HTMLTableElement>) => void;
  /** Releases the focused column only when focus leaves the table. */
  onBlur: (event: FocusEvent<HTMLTableElement>) => void;
}

interface InlinePending {
  snapshot: TableInlineGeometry;
  to: number;
}
interface InlineTracking {
  source: TableInlineGeometrySource;
  snapshot: TableInlineGeometry;
  runKeys: ReadonlyArray<string>;
  offsets: ReadonlyArray<number>;
  firstVisibleIndex: number;
  /** The scrolled part of the first visible column, as a fraction of it. */
  fraction: number;
  pending: InlinePending | undefined;
}

const OVERSCAN = 2;
const UNMEASURED: TableInlineGeometry = Object.freeze({isMeasured: false});
const getUnmeasured = () => UNMEASURED;
const subscribeToNothing = () => () => {};

/** Why mounted header or body cells cannot window, if they cannot. */
function getColumnViolation(table: HTMLTableElement): string | undefined {
  for (const row of Array.from(table.rows)) {
    if (row.getAttribute('aria-hidden') === 'true') {
      continue;
    }
    for (const cell of Array.from(row.cells)) {
      if (cell.getAttribute('aria-hidden') !== 'true' && cell.colSpan > 1) {
        return 'a cell spans columns';
      }
    }
  }
  return undefined;
}

/**
 * The cell that holds `target`, and its full-table column index. A windowed
 * cell carries its position; an unwindowed row has no spacers, so there the
 * cell index is the column index.
 */
function getFocusedCell(
  table: HTMLTableElement,
  target: EventTarget,
): {cell: HTMLTableCellElement; index: number} | undefined {
  const view = table.ownerDocument.defaultView;
  if (view == null || !(target instanceof view.Element)) {
    return undefined;
  }
  const cell = target.closest('td, th');
  if (
    !(cell instanceof view.HTMLTableCellElement) ||
    !table.contains(cell) ||
    cell.getAttribute('aria-hidden') === 'true'
  ) {
    return undefined;
  }
  const position = cell.getAttribute('aria-colindex');
  return {
    cell,
    index: position == null ? cell.cellIndex : Number(position) - 1,
  };
}

/** Right-to-left viewports report a negative physical inline offset. */
function writeInlineScroll(viewport: HTMLDivElement, logical: number): void {
  const isReversed =
    viewport.ownerDocument.defaultView?.getComputedStyle(viewport).direction ===
    'rtl';
  viewport.scrollLeft = isReversed ? -logical : logical;
}

export function useTableColumnWindow({
  config,
  isAdmitted,
  widths,
  startCount,
  endCount,
  columnKeys,
  table,
  viewport,
  geometry,
}: UseTableColumnWindowOptions): TableColumnWindowResult {
  const columnCount = widths.length;
  const runStart = Math.min(columnCount, Math.max(0, startCount));
  const runEnd = Math.max(runStart, columnCount - Math.max(0, endCount));
  const [rejected, setRejected] = useState<{
    widths: ReadonlyArray<number>;
    config: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
    reason: string;
  }>();
  const isRejected = rejected?.widths === widths && rejected.config === config;
  useDevWarningPerMessage(
    'Table',
    `Column windowing disabled: ${rejected?.reason}. Rendering every column.`,
    isRejected,
  );
  const canWindow =
    isAdmitted &&
    !isRejected &&
    config !== undefined &&
    isPositiveFinite(config.initialViewportWidth) &&
    runEnd > runStart &&
    columnKeys.length === columnCount &&
    widths.every(width => Number.isFinite(width) && width >= 0);
  const snapshot = useSyncExternalStore(
    canWindow ? geometry.subscribeInline : subscribeToNothing,
    canWindow ? geometry.getSnapshot : getUnmeasured,
    canWindow ? geometry.getServerSnapshot : getUnmeasured,
  );
  const [focusedKey, setFocusedKey] = useState<string | undefined>();
  const [tracking, setTracking] = useState<InlineTracking | undefined>();
  const focusNoteRef = useRef<FocusWithin | null>(null);
  // Focus return reads the last input, so only a windowing table tracks it.
  useInteractionModalityTrackingFor(viewport, canWindow);

  // Prefix offsets of the windowed run, and the pinned run sizes.
  const layout = useMemo(() => {
    const offsets = [0];
    for (let index = runStart; index < runEnd; index++) {
      offsets.push(offsets[offsets.length - 1] + widths[index]);
    }
    let pinnedStart = 0;
    for (let index = 0; index < runStart; index++) {
      pinnedStart += widths[index];
    }
    let pinnedEnd = 0;
    for (let index = runEnd; index < columnCount; index++) {
      pinnedEnd += widths[index];
    }
    return {offsets, pinnedStart, pinnedEnd};
  }, [widths, runStart, runEnd, columnCount]);
  // Key work runs when the columns change, never on a scroll.
  const runKeys = useMemo(
    () => columnKeys.slice(runStart, runEnd),
    [columnKeys, runStart, runEnd],
  );
  const runKeyIndices = useMemo(
    () => new Map(runKeys.map((key, index) => [key, index])),
    [runKeys],
  );
  const isFocusedKeyRemoved =
    focusedKey !== undefined && !columnKeys.includes(focusedKey);
  if (isFocusedKeyRemoved) {
    setFocusedKey(undefined);
  }
  const focusRunIndex =
    focusedKey === undefined ? undefined : runKeyIndices.get(focusedKey);

  const isMeasured =
    snapshot.isMeasured &&
    isPositiveFinite(snapshot.viewportWidth ?? 0) &&
    Number.isFinite(snapshot.scrollLeft ?? 0);
  // The pinned runs cover the viewport's edges, so only the space between
  // them shows the windowed run. The seed plans for the same space.
  const viewportSize =
    (isMeasured
      ? (snapshot.viewportWidth ?? 0)
      : (config?.initialViewportWidth ?? 0)) -
    layout.pinnedStart -
    layout.pinnedEnd;
  // Column order, width, visibility and pinning keep the first visible
  // column's key and its fractional offset.
  const last = tracking;
  const anchorScroll =
    canWindow &&
    isMeasured &&
    last !== undefined &&
    (last.runKeys !== runKeys || last.offsets !== layout.offsets)
      ? reconcileListAnchor({
          previousKeys: last.runKeys,
          keys: runKeys,
          keyIndices: runKeyIndices,
          firstVisibleIndex: last.firstVisibleIndex,
          offset: last.fraction,
          offsets: layout.offsets,
          rowHeight: 0,
          viewportHeight: viewportSize,
          startOffset: 0,
        })
      : undefined;
  const pending = tracking?.pending;
  const isAwaitingAnchor =
    tracking?.source === geometry &&
    pending !== undefined &&
    pending.snapshot.scrollLeft === snapshot.scrollLeft &&
    (pending.to !== snapshot.scrollLeft || pending.snapshot === snapshot);
  const pendingScroll =
    anchorScroll ?? (isAwaitingAnchor ? pending.to : undefined);
  const range = canWindow
    ? calculateVariableListRange({
        offsets: layout.offsets,
        viewportSize,
        scrollOffset: isMeasured
          ? (pendingScroll ?? snapshot.scrollLeft ?? 0)
          : 0,
        isMeasured,
        overscan: OVERSCAN,
      })
    : undefined;
  // The last window feeds the anchor, so it lives in state. Immutable inputs
  // limit this update to one extra render.
  if (range !== undefined && isMeasured) {
    if (
      tracking === undefined ||
      tracking.source !== geometry ||
      tracking.snapshot !== snapshot ||
      tracking.runKeys !== runKeys ||
      tracking.offsets !== layout.offsets
    ) {
      const firstWidth =
        layout.offsets[range.firstVisibleIndex + 1] -
        layout.offsets[range.firstVisibleIndex];
      setTracking({
        source: geometry,
        snapshot,
        runKeys,
        offsets: layout.offsets,
        firstVisibleIndex: range.firstVisibleIndex,
        fraction: firstWidth > 0 ? range.offset / firstWidth : 0,
        pending:
          anchorScroll !== undefined
            ? {snapshot, to: anchorScroll}
            : isAwaitingAnchor
              ? pending
              : undefined,
      });
    }
  } else if (tracking !== undefined && !canWindow) {
    setTracking(undefined);
  }
  const runCount = runEnd - runStart;
  const isWindowed =
    range !== undefined && (range.start > 0 || range.end < runCount);
  const rangeStart = isWindowed ? range.start : 0;
  const rangeEnd = isWindowed ? range.end : runCount;

  // A scroll inside the mounted range keeps the exact segment array.
  const segments = useMemo<TableColumnSegment[]>(() => {
    if (!isWindowed) {
      return columnCount === 0
        ? []
        : [{type: 'columns', start: 0, end: columnCount}];
    }
    const next: TableColumnSegment[] = [];
    if (runStart > 0) {
      next.push({type: 'columns', start: 0, end: runStart});
    }
    // At most three spacers: before the range, between the range and the
    // focused column, and after both.
    for (const segment of createListWindowSegments(
      runCount,
      1,
      rangeStart,
      rangeEnd,
      focusRunIndex,
    )) {
      next.push(
        segment.type === 'gap'
          ? {
              type: 'gap',
              start: runStart + segment.start,
              end: runStart + segment.end,
              width:
                layout.offsets[segment.end] - layout.offsets[segment.start],
            }
          : {
              type: 'columns',
              start: runStart + segment.start,
              end: runStart + segment.end,
            },
      );
    }
    if (runEnd < columnCount) {
      next.push({type: 'columns', start: runEnd, end: columnCount});
    }
    return next;
  }, [
    isWindowed,
    rangeStart,
    rangeEnd,
    focusRunIndex,
    runStart,
    runEnd,
    runCount,
    columnCount,
    layout,
  ]);

  const onFocus = useCallback(
    (event: FocusEvent<HTMLTableElement>) => {
      const focused = getFocusedCell(event.currentTarget, event.target);
      const key = focused === undefined ? undefined : columnKeys[focused.index];
      if (focused === undefined || key === undefined) {
        return;
      }
      focusNoteRef.current =
        noteFocusWithin(focused.cell) ?? focusNoteRef.current;
      setFocusedKey(key);
    },
    [columnKeys],
  );
  const onBlur = useCallback((event: FocusEvent<HTMLTableElement>) => {
    const leavesDocument =
      event.relatedTarget == null &&
      !event.currentTarget.ownerDocument.hasFocus();
    if (!leavesDocument && !event.currentTarget.contains(event.relatedTarget)) {
      focusNoteRef.current = null;
      setFocusedKey(undefined);
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    // Syncs DOM focus and the inline scroll position with the committed columns.
    if (focusNoteRef.current != null && focusedKey === undefined) {
      moveFocusLeftBehind(focusNoteRef.current, viewport.current, null, {
        preventScroll: true,
      });
      focusNoteRef.current = null;
    }
    const node = viewport.current;
    if (
      pendingScroll !== undefined &&
      node != null &&
      Math.abs(Math.abs(node.scrollLeft) - pendingScroll) > 0.5
    ) {
      writeInlineScroll(node, pendingScroll);
    }
  });

  // Spanning cells come from plugin transforms, so they are known only after
  // they mount. Reads only mounted cells; one such cell renders every column.
  useIsomorphicLayoutEffect(() => {
    if (!isWindowed || table.current == null) {
      return;
    }
    const reason = getColumnViolation(table.current);
    if (reason) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect -- records a violation read from mounted cells
      setRejected({widths, config, reason});
    }
  }, [isWindowed, segments, table, widths, config]);

  return useMemo(
    () => ({
      segments,
      isWindowed,
      isActive: canWindow,
      onFocus,
      onBlur,
    }),
    [segments, isWindowed, canWindow, onFocus, onBlur],
  );
}
