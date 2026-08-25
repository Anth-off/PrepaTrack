import { describe, expect, it } from 'vitest'
import { toCartMotionSample } from './cartMotion'

describe('capteurs natifs du chariot', () => {
  it('conserve l’horodatage et les trois axes Core Motion', () => {
    expect(toCartMotionSample({ at: 1234, x: 1, y: -2, z: 3 })).toEqual({
      at: 1234,
      acceleration: { x: 1, y: -2, z: 3 },
    })
  })
})
