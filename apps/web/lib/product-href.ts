/** Public Product refs own browser links; UUIDs remain write identities. */
export function productPublicId(product: { publicId: string }) {
  return product.publicId
}

export function productHref(product: { publicId: string }) {
  return `/products/${encodeURIComponent(productPublicId(product))}`
}
