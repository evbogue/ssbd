const encoder = new TextEncoder()

export function canonicalStringify(value, dropSignature = false) {
  const ordered = {}
  for (const key of Object.keys(value)) {
    if (dropSignature && key === 'signature') continue
    ordered[key] = value[key]
  }
  return JSON.stringify(ordered, null, 2)
}

export function canonicalBytes(value) {
  const dropSignature = value && Object.prototype.hasOwnProperty.call(value, 'signature')
  const text = canonicalStringify(value, dropSignature)
  return encoder.encode(text)
}
