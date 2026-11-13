/** An object this call stored: the generation GCS gave it, which is what makes a later removal safe. */
export interface StoredObject {
  /** The generation number of the stored object, as text. */
  readonly generation: string;
}

/** Options of a storage call. */
export interface StorageCallOptions {
  /** Aborts the call (and its retries) when it fires: the deadline of the whole operation. */
  readonly signal?: AbortSignal;
}

/**
 * What the application needs from an object storage for media: put an object that does not exist yet, remove only what this process stored. The only
 * implementation is Google Cloud Storage ({@link createGcsStorage}); no detail of the provider crosses this interface.
 */
export interface MediaStorage {
  /**
   * Stores an object, never overwriting one: names are unique, and a name that is taken is a failure (`exists`).
   *
   * @param objectName Path of the object in the bucket, built by the server (`<groupHex>/media/image/<size>/<basename>`).
   * @param body The bytes.
   * @param contentType The real media type of the bytes.
   * @param options Deadline.
   * @returns The stored object, with its generation.
   * @throws {StorageError} When the object cannot be stored (`exists` when the name is taken).
   */
  upload(objectName: string, body: Buffer, contentType: string, options?: StorageCallOptions): Promise<StoredObject>;
  /**
   * Removes the object of a generation this process stored: the removal is conditional on that generation, so an object that replaced it is never touched.
   * One that is already gone is not an error.
   *
   * @param objectName Path of the object in the bucket.
   * @param generation The generation `upload` returned.
   * @param options Deadline.
   * @throws {StorageError} When the provider cannot be reached or refuses.
   */
  remove(objectName: string, generation: string, options?: StorageCallOptions): Promise<void>;
  /**
   * Removes an object after an upload whose outcome is not known (the answer was lost), but only when it is the very bytes this process sent: the object is read back,
   * its MD5 compared with the one of `body`, and only then removed, with its generation. An object that is missing or is another one is left alone.
   *
   * @param objectName Path of the object in the bucket.
   * @param body The bytes that were being uploaded.
   * @param options Deadline.
   * @throws {StorageError} When the provider cannot be reached or refuses.
   */
  removeIfSame(objectName: string, body: Buffer, options?: StorageCallOptions): Promise<void>;
}
