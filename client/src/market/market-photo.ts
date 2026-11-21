/** Marketplace M12: the photo chosen from a search box, handed to /search/image (a File cannot travel in a URL). */
let pending: File | null = null;
export function setPendingPhoto(file: File) {
  pending = file;
}
export function takePendingPhoto(): File | null {
  const file = pending;
  pending = null;
  return file;
}
