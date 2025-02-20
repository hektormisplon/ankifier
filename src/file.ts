import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import {
  Note,
  InlineNote,
  RegexNote,
  CLOZE_ERROR,
  NOTE_TYPE_ERROR,
  TAG_SEP,
  ID_REGEXP_STR,
  TAG_REGEXP_STR,
} from './note'
import * as AnkiConnect from './anki'
import { Request as AnkiConnectRequest } from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { toInlineHTMLComment } from './lib/html'
import { CachedMetadata, HeadingCache } from 'obsidian'

/*
 * Performing plugin operations on markdown file contents
 */

/*
 * Return ID string for a given the note ID.  Wrapped in a
 * comment based on the user's settings
 */

const generateIDString = (id: number, comment = false): string =>
  comment ? toInlineHTMLComment(`ID: ${id}`) : `ID: ${id}`

/*
 *
 */

const insertIntoString = (text: string, position_inserts: Array<[number, string]>): string => {
  /*Insert strings in position_inserts into text, at indices.
    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]*/

  let offset = 0
  const sorted: Array<[number, string]> = position_inserts.sort((a, b): number => a[0] - b[0])
  for (const insertion of sorted) {
    const position = insertion[0]
    const insert_str = insertion[1]
    text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
    offset += insert_str.length
  }
  return text
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
  /*Return a list of span-tuples for matches of pattern in text.*/
  const output: Array<[number, number]> = []
  const matches = text.matchAll(pattern)
  for (const match of matches) {
    output.push([match.index, match.index + match[0].length])
  }
  return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
  /*Return whether span is contained in spans (+- 1 leeway)*/
  return spans.some((element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1)
}

function* findignore(
  pattern: RegExp,
  text: string,
  ignore_spans: Array<[number, number]>
): IterableIterator<RegExpMatchArray> {
  const matches = text.matchAll(pattern)
  for (const match of matches) {
    if (!contained_in([match.index, match.index + match[0].length], ignore_spans)) {
      yield match
    }
  }
}

abstract class AbstractFile {
  file: string
  path: string
  url: string
  original_file: string
  data: FileData
  file_cache: CachedMetadata

  frozen_fields_dict: FROZEN_FIELDS_DICT
  target_deck: string
  global_tags: string

  notes_to_add: AnkiConnectNote[]
  id_indexes: number[]
  notes_to_edit: AnkiConnectNoteAndID[]
  notes_to_delete: number[]
  all_notes_to_add: AnkiConnectNote[]

  note_ids: Array<number | null>
  card_ids: number[]
  tags: string[]

  formatter: FormatConverter

  constructor(
    file_contents: string,
    path: string,
    url: string,
    data: FileData,
    file_cache: CachedMetadata
  ) {
    this.data = data
    this.file = file_contents
    this.path = path
    this.url = url
    this.original_file = this.file
    this.file_cache = file_cache
    this.formatter = new FormatConverter(file_cache, this.data.vault_name)
  }

  setup_frozen_fields_dict() {
    const frozen_fields_dict: FROZEN_FIELDS_DICT = {}
    for (const note_type in this.data.fields_dict) {
      const fields: string[] = this.data.fields_dict[note_type]
      const temp_dict: Record<string, string> = {}
      for (const field of fields) {
        temp_dict[field] = ''
      }
      frozen_fields_dict[note_type] = temp_dict
    }
    for (const match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
      const [note_type, fields]: [string, string] = [match[1], match[2]]
      const virtual_note = note_type + '\n' + fields
      const parsed_fields: Record<string, string> = new Note(
        virtual_note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).getFields()
      frozen_fields_dict[note_type] = parsed_fields
    }
    this.frozen_fields_dict = frozen_fields_dict
  }

  setup_target_deck() {
    const result = this.file.match(this.data.DECK_REGEXP)
    this.target_deck = result ? result[1] : this.data.template['deckName']
  }

  setup_global_tags() {
    const result = this.file.match(this.data.TAG_REGEXP)
    this.global_tags = result ? result[1] : ''
  }

  abstract scanFile(): void

  scanDeletions() {
    for (const match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
      this.notes_to_delete.push(parseInt(match[1]))
    }
  }

  getContextAtIndex(position: number): string {
    const result: string = this.path
    let currentContext: HeadingCache[] = []
    if (!this.file_cache.hasOwnProperty('headings')) {
      return result
    }
    for (const currentHeading of this.file_cache.headings) {
      if (position < currentHeading.position.start.offset) {
        //We've gone past position now with headings, so let's return!
        break
      }
      let insert_index = 0
      for (const contextHeading of currentContext) {
        if (currentHeading.level > contextHeading.level) {
          insert_index += 1
          continue
        }
        break
      }
      currentContext = currentContext.slice(0, insert_index)
      currentContext.push(currentHeading)
    }
    const heading_strs: string[] = []
    for (const contextHeading of currentContext) {
      heading_strs.push(contextHeading.heading)
    }
    const result_arr: string[] = [result]
    result_arr.push(...heading_strs)
    return result_arr.join(' > ')
  }

  abstract writeIDs(): void

  removeEmpties() {
    this.file = this.file.replace(this.data.EMPTY_REGEXP, '')
  }

  getAddNotes(): AnkiConnectRequest {
    const actions: AnkiConnectRequest[] = []
    for (const note of this.all_notes_to_add) {
      actions.push(AnkiConnect.addNote(note))
    }
    return AnkiConnect.multi(actions)
  }

  getDeleteNotes(): AnkiConnectRequest {
    return AnkiConnect.deleteNotes(this.notes_to_delete)
  }

  getUpdateFields(): AnkiConnectRequest {
    const actions: AnkiConnectRequest[] = []
    for (const {
      identifier: id,
      note: { fields },
    } of this.notes_to_edit) {
      actions.push(AnkiConnect.updateNoteFields({ id, fields }))
    }
    return AnkiConnect.multi(actions)
  }

  getNoteInfo(): AnkiConnectRequest {
    const IDs: number[] = []
    for (const parsed of this.notes_to_edit) {
      IDs.push(parsed.identifier)
    }
    return AnkiConnect.notesInfo(IDs)
  }

  getChangeDecks(): AnkiConnectRequest {
    return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
  }

  getClearTags(): AnkiConnectRequest {
    const IDs: number[] = []
    for (const parsed of this.notes_to_edit) {
      IDs.push(parsed.identifier)
    }
    return AnkiConnect.removeTags(IDs, this.tags.join(' '))
  }

  getAddTags(): AnkiConnectRequest {
    const actions: AnkiConnectRequest[] = []
    for (const parsed of this.notes_to_edit) {
      actions.push(
        AnkiConnect.addTags(
          [parsed.identifier],
          parsed.note.tags.join(' ') + ' ' + this.global_tags
        )
      )
    }
    return AnkiConnect.multi(actions)
  }
}

export class AllFile extends AbstractFile {
  ignore_spans: [number, number][]
  custom_regexps: Record<string, string>
  inline_notes_to_add: AnkiConnectNote[]
  inline_id_indexes: number[]
  regex_notes_to_add: AnkiConnectNote[]
  regex_id_indexes: number[]

  constructor(
    file_contents: string,
    path: string,
    url: string,
    data: FileData,
    file_cache: CachedMetadata
  ) {
    super(file_contents, path, url, data, file_cache)
    this.custom_regexps = data.custom_regexps
  }

  add_spans_to_ignore() {
    this.ignore_spans = []
    this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
    const deck_result = this.file.match(this.data.DECK_REGEXP)
    if (deck_result) {
      this.ignore_spans.push([deck_result.index, deck_result.index + deck_result[0].length])
    }
    const tag_result = this.file.match(this.data.TAG_REGEXP)
    if (tag_result) {
      this.ignore_spans.push([tag_result.index, tag_result.index + tag_result[0].length])
    }
    this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
    this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.INLINE_DOLLAR_MATH_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.DISPLAY_DOLLAR_MATH_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
  }

  setupScan() {
    this.setup_frozen_fields_dict()
    this.setup_target_deck()
    this.setup_global_tags()
    this.add_spans_to_ignore()
    this.notes_to_add = []
    this.inline_notes_to_add = []
    this.regex_notes_to_add = []
    this.id_indexes = []
    this.inline_id_indexes = []
    this.regex_id_indexes = []
    this.notes_to_edit = []
    this.notes_to_delete = []
  }

  scanNotes() {
    for (const note_match of this.file.matchAll(this.data.NOTE_REGEXP)) {
      const [note, position]: [string, number] = [
        note_match[1],
        note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length,
      ]

      // That second thing essentially gets the index of the end of the first capture group.
      const parsed = new Note(
        note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).parse(
        this.target_deck,
        this.url,
        this.frozen_fields_dict,
        this.data,
        this.data.add_context ? this.getContextAtIndex(note_match.index) : ''
      )
      if (parsed.identifier == null) {
        // Need to make sure global_tags get added
        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
        this.notes_to_add.push(parsed.note)
        this.id_indexes.push(position)
      } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
        if (parsed.identifier == CLOZE_ERROR) {
          continue
        }
        // Need to show an error otherwise
        else if (parsed.identifier == NOTE_TYPE_ERROR) {
          console.warn(
            'Did not recognise note type ',
            parsed.note.modelName,
            ' in file ',
            this.path
          )
        } else {
          console.warn(
            'Note with id',
            parsed.identifier,
            ' in file ',
            this.path,
            ' does not exist in Anki!'
          )
        }
      } else {
        this.notes_to_edit.push(parsed)
      }
    }
  }

  scanInlineNotes() {
    for (const note_match of this.file.matchAll(this.data.INLINE_REGEXP)) {
      const [note, position]: [string, number] = [
        note_match[1],
        note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length,
      ]
      // That second thing essentially gets the index of the end of the first capture group.
      const parsed = new InlineNote(
        note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).parse(
        this.target_deck,
        this.url,
        this.frozen_fields_dict,
        this.data,
        this.data.add_context ? this.getContextAtIndex(note_match.index) : ''
      )
      if (parsed.identifier == null) {
        // Need to make sure global_tags get added
        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
        this.inline_notes_to_add.push(parsed.note)
        this.inline_id_indexes.push(position)
      } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
        // Need to show an error
        if (parsed.identifier == CLOZE_ERROR) {
          continue
        }
        console.warn(
          'Note with id',
          parsed.identifier,
          ' in file ',
          this.path,
          ' does not exist in Anki!'
        )
      } else {
        this.notes_to_edit.push(parsed)
      }
    }
  }

  search(note_type: string, regexp_str: string) {
    //  Search file for regex matches ignoring matches in ignore_spans,
    //  and adding any matches to ignore_spans.
    for (const search_id of [true, false]) {
      for (const search_tags of [true, false]) {
        const id_str = search_id ? ID_REGEXP_STR : ''
        const tag_str = search_tags ? TAG_REGEXP_STR : ''
        const regexp = new RegExp(regexp_str + tag_str + id_str, 'gm')
        for (const match of findignore(regexp, this.file, this.ignore_spans)) {
          this.ignore_spans.push([match.index, match.index + match[0].length])
          const parsed: AnkiConnectNoteAndID = new RegexNote(
            match,
            note_type,
            this.data.fields_dict,
            search_tags,
            search_id,
            this.data.curly_cloze,
            this.data.highlights_to_cloze,
            this.formatter
          ).parse(
            this.target_deck,
            this.url,
            this.frozen_fields_dict,
            this.data,
            this.data.add_context ? this.getContextAtIndex(match.index) : ''
          )
          if (search_id) {
            if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
              if (parsed.identifier == CLOZE_ERROR) {
                // This means it wasn't actually a note! So we should remove it from ignore_spans
                this.ignore_spans.pop()
                continue
              }
              console.warn(
                'Note with id',
                parsed.identifier,
                ' in file ',
                this.path,
                ' does not exist in Anki!'
              )
            } else {
              this.notes_to_edit.push(parsed)
            }
          } else {
            if (parsed.identifier == CLOZE_ERROR) {
              // This means it wasn't actually a note! So we should remove it from ignore_spans
              this.ignore_spans.pop()
              continue
            }
            parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
            this.regex_notes_to_add.push(parsed.note)
            this.regex_id_indexes.push(match.index + match[0].length)
          }
        }
      }
    }
  }

  scanFile() {
    this.setupScan()
    this.scanNotes()
    this.scanInlineNotes()
    for (const note_type in this.custom_regexps) {
      const regexp_str: string = this.custom_regexps[note_type]
      if (regexp_str) {
        this.search(note_type, regexp_str)
      }
    }
    this.all_notes_to_add = [
      ...this.notes_to_add,
      ...this.inline_notes_to_add,
      ...this.regex_notes_to_add,
    ]
    this.scanDeletions()
  }

  writeIDs() {
    type fileID = [number, string][]
    type ID = number | null

    const {
      id_indexes,
      inline_id_indexes,
      regex_id_indexes,
      note_ids,
      data,
      notes_to_add,
      inline_notes_to_add,
    } = this

    const normalIDs: fileID = []
    const inlineIDs: fileID = []
    const regexIDs: fileID = []

    id_indexes.forEach((pos: number, i: number) => {
      const id: ID = note_ids[i]
      if (id) normalIDs.push([pos, generateIDString(id, data.comment) + '\n'])
    })

    inline_id_indexes.forEach((pos: number, i: number) => {
      const id: ID = note_ids[i + notes_to_add.length] // Since regular then inline
      if (id) inlineIDs.push([pos, generateIDString(id, data.comment)])
    })

    regex_id_indexes.forEach((pos: number, i: number) => {
      const id: ID = note_ids[i + notes_to_add.length + inline_notes_to_add.length] // Since regular then inline then regex
      if (id) regexIDs.push([pos, '\n' + generateIDString(id, data.comment)])
    })

    // Insert IDs into file
    this.file = insertIntoString(this.file, [...normalIDs, ...inlineIDs, ...regexIDs])
  }
}
