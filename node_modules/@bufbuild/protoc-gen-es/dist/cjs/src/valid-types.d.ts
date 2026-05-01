import { type DescField, type DescMessage } from "@bufbuild/protobuf";
/**
 * Returns true if the given message needs a ValidType. A message needs a ValidType
 * if one or more of the following conditions are true:
 * - A proto2 field has the `required` label
 * - A edition field has the feature `field_presence = LEGACY_REQUIRED`
 * - A field has the protovalidate `required` rule and not `ignore = IGNORE_ALWAYS`
 * - A message field (repeated, singular, or map value) needs a ValidType
 */
export declare function messageNeedsCustomValidType(message: DescMessage, options: {
    legacyRequired: boolean;
    protovalidateRequired: boolean;
}): boolean;
/**
 * Returns true if the field's protovalidate rules are (conditionally) disabled.
 *
 * Note that this function only applies to message fields (singular, repeated, map),
 * and always returns false for other field types.
 */
export declare function isProtovalidateDisabled(descField: DescField): boolean;
/**
 * Returns true if the field is required by protovalidate.
 *
 * Note that this function only applies to message fields (singular, repeated, map),
 * and always returns false for other field types.
 */
export declare function isProtovalidateRequired(descField: DescField): boolean;
/**
 * Returns true if the field has the proto2 `required` label, or the Edition
 * feature field_presence = LEGACY_REQUIRED.
 *
 * Note that this function only applies to singular message fields, and always
 * returns false for other fields.
 */
export declare function isLegacyRequired(descField: DescField): boolean;
