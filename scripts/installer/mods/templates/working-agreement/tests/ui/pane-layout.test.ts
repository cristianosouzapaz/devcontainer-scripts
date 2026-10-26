import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { layoutLabelRows, measureLabelWidth } from '../../hooks/ui/pane-layout'

// A pill is ` label ` wide, two columns apart: `aa` and `bbb` take 4 + 2 + 5 = 11 columns.
test('labels that fit share one row', () => {
  expect(layoutLabelRows(['aa', 'bbb'], 11)).toEqual([['aa', 'bbb']])
})

test('a label that would overflow the width starts the next row, at the exact boundary', () => {
  expect(layoutLabelRows(['aa', 'bbb'], 10)).toEqual([['aa'], ['bbb']])
  expect(layoutLabelRows(['aa', 'bbb', 'c'], 15)).toEqual([['aa', 'bbb'], ['c']])
  expect(layoutLabelRows(['aa', 'bbb', 'c'], 16)).toEqual([['aa', 'bbb', 'c']])
})

test('a label wider than the width is truncated at the end to fill its own row and is never dropped', () => {
  expect(layoutLabelRows(['a', 'very-long-label', 'b'], 8)).toEqual([['a'], ['very-…'], ['b']])
  expect(layoutLabelRows(['very-long-label'], 4)).toEqual([['v…']])
})

test('a pill truncates only below its padded width, and the truncated width decides the next row', () => {
  expect(layoutLabelRows(['ready-for-agent'], 17)).toEqual([['ready-for-agent']])
  expect(layoutLabelRows(['ready-for-agent'], 16)).toEqual([['ready-for-age…']])
  expect(layoutLabelRows(['ready-for-agent'], 15)).toEqual([['ready-for-ag…']])
  expect(layoutLabelRows(['ready-for-agent', 'b'], 16)).toEqual([['ready-for-age…'], ['b']])
})

test('no labels make no rows', () => {
  expect(layoutLabelRows([], 20)).toEqual([])
})

test('the label column is the body less its padding and the key column, at least one', () => {
  expect(measureLabelWidth(40)).toBe(26)
  expect(measureLabelWidth(5)).toBe(1)
})
