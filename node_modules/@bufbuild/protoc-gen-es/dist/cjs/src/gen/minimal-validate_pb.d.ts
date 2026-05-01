import type { GenEnum, GenExtension, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { FieldOptions, OneofOptions } from "@bufbuild/protobuf/wkt";
import type { Message } from "@bufbuild/protobuf";
/**
 * Describes the file minimal-validate.proto.
 */
export declare const file_minimal_validate: GenFile;
/**
 * @generated from message buf.validate.OneofRules
 */
export type OneofRules = Message<"buf.validate.OneofRules"> & {
    /**
     * @generated from field: optional bool required = 1;
     */
    required: boolean;
};
/**
 * Describes the message buf.validate.OneofRules.
 * Use `create(OneofRulesSchema)` to create a new message.
 */
export declare const OneofRulesSchema: GenMessage<OneofRules>;
/**
 * @generated from message buf.validate.FieldRules
 */
export type FieldRules = Message<"buf.validate.FieldRules"> & {
    /**
     * @generated from field: optional bool required = 25;
     */
    required: boolean;
    /**
     * @generated from field: optional buf.validate.Ignore ignore = 27;
     */
    ignore: Ignore;
    /**
     * @generated from oneof buf.validate.FieldRules.type
     */
    type: {
        /**
         * @generated from field: buf.validate.RepeatedRules repeated = 18;
         */
        value: RepeatedRules;
        case: "repeated";
    } | {
        /**
         * @generated from field: buf.validate.MapRules map = 19;
         */
        value: MapRules;
        case: "map";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message buf.validate.FieldRules.
 * Use `create(FieldRulesSchema)` to create a new message.
 */
export declare const FieldRulesSchema: GenMessage<FieldRules>;
/**
 * @generated from message buf.validate.RepeatedRules
 */
export type RepeatedRules = Message<"buf.validate.RepeatedRules"> & {
    /**
     * @generated from field: optional buf.validate.FieldRules items = 4;
     */
    items?: FieldRules | undefined;
};
/**
 * Describes the message buf.validate.RepeatedRules.
 * Use `create(RepeatedRulesSchema)` to create a new message.
 */
export declare const RepeatedRulesSchema: GenMessage<RepeatedRules>;
/**
 * @generated from message buf.validate.MapRules
 */
export type MapRules = Message<"buf.validate.MapRules"> & {
    /**
     * @generated from field: optional buf.validate.FieldRules values = 5;
     */
    values?: FieldRules | undefined;
};
/**
 * Describes the message buf.validate.MapRules.
 * Use `create(MapRulesSchema)` to create a new message.
 */
export declare const MapRulesSchema: GenMessage<MapRules>;
/**
 * @generated from enum buf.validate.Ignore
 */
export declare enum Ignore {
    /**
     * @generated from enum value: IGNORE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: IGNORE_IF_ZERO_VALUE = 1;
     */
    IF_ZERO_VALUE = 1,
    /**
     * @generated from enum value: IGNORE_ALWAYS = 3;
     */
    ALWAYS = 3
}
/**
 * Describes the enum buf.validate.Ignore.
 */
export declare const IgnoreSchema: GenEnum<Ignore>;
/**
 * @generated from extension: optional buf.validate.OneofRules oneof = 1159;
 */
export declare const oneof: GenExtension<OneofOptions, OneofRules>;
/**
 * @generated from extension: optional buf.validate.FieldRules field = 1159;
 */
export declare const field: GenExtension<FieldOptions, FieldRules>;
