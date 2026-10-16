import { contentHash } from "@autonomous-trading-lab/domain";
import { EntitySchema, type Entity } from "./schemas.js";

export class EntityLabelRegistry {
  readonly #byId = new Map<string, { entity: Entity; hash: `sha256:${string}` }>();
  readonly #entityIdsByAddress = new Map<string, Set<string>>();

  public register(candidate: Entity): `sha256:${string}` {
    const entity = EntitySchema.parse(candidate);
    const hash = contentHash(entity);
    const existing = this.#byId.get(entity.entityId);
    if (existing) {
      // Content identities are public research hashes, not authentication secrets.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (existing.hash !== hash) throw new Error("entity identity is immutable");
      return hash;
    }
    this.#byId.set(entity.entityId, { entity: structuredClone(entity), hash });
    for (const address of entity.addresses) {
      const ids = this.#entityIdsByAddress.get(address) ?? new Set<string>();
      ids.add(entity.entityId);
      this.#entityIdsByAddress.set(address, ids);
    }
    return hash;
  }

  public lookupAddress(address: string, asOf: string): readonly Entity[] {
    const ids = this.#entityIdsByAddress.get(address) ?? new Set<string>();
    return [...ids]
      .flatMap((id) => {
        const entity = this.#byId.get(id)?.entity;
        if (!entity || entity.firstSeen > asOf || entity.lastSeen < asOf) return [];
        return [structuredClone(entity)];
      })
      .sort(
        (left, right) =>
          right.confidence - left.confidence || left.entityId.localeCompare(right.entityId),
      );
  }
}
