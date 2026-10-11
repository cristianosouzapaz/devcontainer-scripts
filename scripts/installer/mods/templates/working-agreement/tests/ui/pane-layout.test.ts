import { expect, test } from 'claude-code/testing'

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

test('a label wider than the width sits alone on its row and is never dropped', () => {
  expect(layoutLabelRows(['a', 'very-long-label', 'b'], 8)).toEqual([['a'], ['very-long-label'], ['b']])
  expect(layoutLabelRows(['very-long-label'], 4)).toEqual([['very-long-label']])
})

test('no labels make no rows', () => {
  expect(layoutLabelRows([], 20)).toEqual([])
})

test('the label column is the body less its padding and the key column, at least one', () => {
  expect(measureLabelWidth(40)).toBe(26)
  expect(measureLabelWidth(5)).toBe(1)
})
