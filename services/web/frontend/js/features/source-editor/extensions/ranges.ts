import { EditorState, StateEffect, TransactionSpec } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view'
import {
  Change,
  DeleteOperation,
  EditOperation,
} from '../../../../../types/change'
import { debugConsole } from '@/utils/debugging'
import {
  isCommentOperation,
  isDeleteOperation,
  isInsertOperation,
} from '@/utils/operations'
import { DocumentContainer } from '@/features/ide-react/editor/document-container'
import { trackChangesAnnotation } from '@/features/source-editor/extensions/realtime'
import { Ranges } from '@/features/review-panel-new/context/ranges-context'
import { Threads } from '@/features/review-panel-new/context/threads-context'

type RangesData = {
  ranges: Ranges
  threads: Threads
}

const updateRangesEffect = StateEffect.define<RangesData>()

export const updateRanges = (data: RangesData): TransactionSpec => {
  return {
    effects: updateRangesEffect.of(data),
  }
}

type Options = {
  currentDoc: DocumentContainer
  loadingThreads?: boolean
  ranges?: Ranges
  threads?: Threads
}

/**
 * A custom extension that initialises the change manager, passes any updates to it,
 * and produces decorations for tracked changes and comments.
 */
export const ranges = ({ ranges, threads }: Options) => {
  return [
    // handle viewportChanged updates
    ViewPlugin.define(view => {
      let timer: number

      return {
        update(update) {
          if (update.viewportChanged) {
            if (timer) {
              window.clearTimeout(timer)
            }

            timer = window.setTimeout(() => {
              dispatchEvent(new Event('editor:viewport-changed'))
            }, 25)
          }
        },
      }
    }),

    // draw change decorations
    ViewPlugin.define<
      PluginValue & {
        decorations: DecorationSet
      }
    >(
      () => {
        return {
          decorations:
            ranges && threads
              ? buildChangeDecorations({ ranges, threads })
              : Decoration.none,
          update(update) {
            for (const transaction of update.transactions) {
              this.decorations = this.decorations.map(transaction.changes)

              for (const effect of transaction.effects) {
                if (effect.is(updateRangesEffect)) {
                  this.decorations = buildChangeDecorations(effect.value)
                }
              }
            }
          },
        }
      },
      {
        decorations: value => value.decorations,
      }
    ),

    // styles for change decorations
    trackChangesTheme,
  ]
}

const buildChangeDecorations = (data: RangesData) => {
  if (!data.ranges) {
    return Decoration.none
  }

  const changes = [...data.ranges.changes, ...data.ranges.comments]

  const decorations = []

  for (const change of changes) {
    try {
      decorations.push(...createChangeRange(change, data))
    } catch (error) {
      // ignore invalid changes
      debugConsole.debug('invalid change position', error)
    }
  }

  return Decoration.set(decorations, true)
}

class ChangeDeletedWidget extends WidgetType {
  constructor(public change: Change<DeleteOperation>) {
    super()
  }

  toDOM() {
    const widget = document.createElement('span')
    widget.classList.add('ol-cm-change')
    widget.classList.add('ol-cm-change-d')

    return widget
  }

  eq() {
    return true
  }
}

class ChangeCalloutWidget extends WidgetType {
  constructor(
    public change: Change,
    public opType: string
  ) {
    super()
  }

  toDOM() {
    const widget = document.createElement('span')
    widget.className = 'ol-cm-change-callout'
    widget.classList.add(`ol-cm-change-callout-${this.opType}`)

    const inner = document.createElement('span')
    inner.classList.add('ol-cm-change-callout-inner')
    widget.appendChild(inner)

    return widget
  }

  eq(widget: ChangeCalloutWidget) {
    return widget.opType === this.opType
  }

  updateDOM(element: HTMLElement) {
    element.className = 'ol-cm-change-callout'
    element.classList.add(`ol-cm-change-callout-${this.opType}`)
    return true
  }
}

const createChangeRange = (change: Change, data: RangesData) => {
  const { id, metadata, op } = change

  const from = op.p
  // TODO: find valid positions?

  if (isDeleteOperation(op)) {
    const opType = 'd'

    const changeWidget = Decoration.widget({
      widget: new ChangeDeletedWidget(change as Change<DeleteOperation>),
      side: 1,
      opType,
      id,
      metadata,
    })

    const calloutWidget = Decoration.widget({
      widget: new ChangeCalloutWidget(change, opType),
      side: 1,
      opType,
      id,
      metadata,
    })

    return [calloutWidget.range(from, from), changeWidget.range(from, from)]
  }

  const _isCommentOperation = isCommentOperation(op)

  if (_isCommentOperation) {
    const thread = data.threads[op.t]
    if (!thread || thread.resolved) {
      return []
    }
  }

  const opType = _isCommentOperation ? 'c' : 'i'
  const changedText = _isCommentOperation ? op.c : op.i
  const to = from + changedText.length

  // Mark decorations must not be empty
  if (from === to) {
    return []
  }

  const changeMark = Decoration.mark({
    tagName: 'span',
    class: `ol-cm-change ol-cm-change-${opType}`,
    opType,
    id,
    metadata,
  })

  const calloutWidget = Decoration.widget({
    widget: new ChangeCalloutWidget(change, opType),
    opType,
    id,
    metadata,
  })

  return [calloutWidget.range(from, from), changeMark.range(from, to)]
}

/**
 * Remove tracked changes from the range tracker when they're rejected,
 * and restore the original content
 */
export const rejectChanges = (
  state: EditorState,
  ranges: DocumentContainer['ranges'],
  changeIds: string[]
) => {
  const changes = ranges!.getChanges(changeIds) as Change<EditOperation>[]

  if (changes.length === 0) {
    return {}
  }

  // When doing bulk rejections, adjacent changes might interact with each other.
  // Consider an insertion with an adjacent deletion (which is a common use-case, replacing words):
  //
  //     "foo bar baz" -> "foo quux baz"
  //
  // The change above will be modeled with two ops, with the insertion going first:
  //
  //     foo quux baz
  //         |--| -> insertion of "quux", op 1, at position 4
  //             | -> deletion of "bar", op 2, pushed forward by "quux" to position 8
  //
  // When rejecting these changes at once, if the insertion is rejected first, we get unexpected
  // results. What happens is:
  //
  //     1) Rejecting the insertion deletes the added word "quux", i.e., it removes 4 chars
  //        starting from position 4;
  //
  //           "foo quux baz" -> "foo  baz"
  //                |--| -> 4 characters to be removed
  //
  //     2) Rejecting the deletion adds the deleted word "bar" at position 8 (i.e. it will act as if
  //        the word "quuux" was still present).
  //
  //            "foo  baz" -> "foo  bazbar"
  //                     | -> deletion of "bar" is reverted by reinserting "bar" at position 8
  //
  // While the intended result would be "foo bar baz", what we get is:
  //
  //      "foo  bazbar" (note "bar" readded at position 8)
  //
  // The issue happens because of step 1. To revert the insertion of "quux", 4 characters are deleted
  // from position 4. This includes the position where the deletion exists; when that position is
  // cleared, the RangesTracker considers that the deletion is gone and stops tracking/updating it.
  // As we still hold a reference to it, the code tries to revert it by readding the deleted text, but
  // does so at the outdated position (position 8, which was valid when "quux" was present).
  //
  // To avoid this kind of problem, we need to make sure that reverting operations doesn't affect
  // subsequent operations that come after. Reverse sorting the operations based on position will
  // achieve it; in the case above, it makes sure that the the deletion is reverted first:
  //
  //     1) Rejecting the deletion adds the deleted word "bar" at position 8
  //
  //            "foo quux baz" -> "foo quuxbar baz"
  //                                       | -> deletion of "bar" is reverted by
  //                                            reinserting "bar" at position 8
  //
  //     2) Rejecting the insertion deletes the added word "quux", i.e., it removes 4 chars
  //        starting from position 4 and achieves the expected result:
  //
  //           "foo quuxbar baz" -> "foo bar baz"
  //                |--| -> 4 characters to be removed

  changes.sort((a, b) => b.op.p - a.op.p)

  const changesToDispatch = changes.map(change => {
    const { op } = change

    if (isInsertOperation(op)) {
      const from = op.p
      const content = op.i
      const to = from + content.length

      const text = state.doc.sliceString(from, to)

      if (text !== content) {
        throw new Error(`Op to be removed does not match editor text`)
      }

      return { from, to, insert: '' }
    } else if (isDeleteOperation(op)) {
      return {
        from: op.p,
        to: op.p,
        insert: op.d,
      }
    } else {
      throw new Error(`unknown change type: ${JSON.stringify(change)}`)
    }
  })

  return {
    changes: changesToDispatch,
    annotations: [trackChangesAnnotation.of('reject')],
  }
}

const trackChangesTheme = EditorView.baseTheme({
  '.cm-line': {
    overflowX: 'hidden', // needed so the callout elements don't overflow (requires line wrapping to be on)
  },
  '&light .ol-cm-change-i': {
    backgroundColor: '#2c8e304d',
  },
  '&dark .ol-cm-change-i': {
    backgroundColor: 'rgba(37, 107, 41, 0.15)',
  },
  '&light .ol-cm-change-c': {
    backgroundColor: '#f3b1114d',
  },
  '&dark .ol-cm-change-c': {
    backgroundColor: 'rgba(194, 93, 11, 0.15)',
  },
  '.ol-cm-change': {
    padding: 'var(--half-leading, 0) 0',
  },
  '.ol-cm-change-d': {
    borderLeft: '2px dotted #c5060b',
    marginLeft: '-1px',
  },
  '.ol-cm-change-callout': {
    position: 'relative',
    pointerEvents: 'none',
    padding: 'var(--half-leading, 0) 0',
  },
  '.ol-cm-change-callout-inner': {
    display: 'inline-block',
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: '100vw',
    borderBottom: '1px dashed black',
  },
  // disable callout line in Firefox
  '@supports (-moz-appearance:none)': {
    '.ol-cm-change-callout-inner': {
      display: 'none',
    },
  },
  '.ol-cm-change-callout-i .ol-cm-change-callout-inner': {
    borderColor: '#2c8e30',
  },
  '.ol-cm-change-callout-c .ol-cm-change-callout-inner': {
    borderColor: '#f3b111',
  },
  '.ol-cm-change-callout-d .ol-cm-change-callout-inner': {
    borderColor: '#c5060b',
  },
})
