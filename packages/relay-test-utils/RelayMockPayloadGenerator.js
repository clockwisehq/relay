/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+relay
 * @flow strict-local
 * @format
 */

'use strict';

const invariant = require('invariant');

const {TYPENAME_KEY, RelayConcreteNode} = require('relay-runtime');

const {
  CONDITION,
  CLIENT_EXTENSION,
  INLINE_FRAGMENT,
  LINKED_FIELD,
  MODULE_IMPORT,
  SCALAR_FIELD,
  LINKED_HANDLE,
  SCALAR_HANDLE,
  DEFER,
  STREAM,
} = RelayConcreteNode;

import type {
  Variables,
  NormalizationOperation,
  NormalizationSelection,
  NormalizationLinkedField,
  NormalizationScalarField,
  OperationDescriptor,
  GraphQLResponse,
} from 'relay-runtime';

type ValueResolver = (
  typeName: ?string,
  context: MockResolverContext,
  plural: ?boolean,
  defaultValue?: mixed,
) => mixed;
type Traversable = {|
  +selections: $ReadOnlyArray<NormalizationSelection>,
  +typeName: ?string,
  +isAbstractType: ?boolean,
  +name: ?string,
  +alias: ?string,
  +args: ?{[string]: mixed},
|};
type MockData = {[string]: mixed};
type MockResolverContext = {|
  +parentType: ?string,
  +name: ?string,
  +alias: ?string,
  +path: ?$ReadOnlyArray<string>,
  +args: ?{[string]: mixed},
|};
type MockResolver = (
  context: MockResolverContext,
  generateId: () => number,
) => mixed;
export type MockResolvers = {[typeName: string]: MockResolver};

type SelectionMetadata = {
  [selectionPath: string]: {|
    +type: string,
    +plural: boolean,
    +nullable: boolean,
    +enumValues: $ReadOnlyArray<string> | null,
  |},
};

function createIdGenerator() {
  let id = 0;
  return () => {
    return ++id;
  };
}

const DEFAULT_MOCK_RESOLVERS = {
  ID(context, generateId: () => number) {
    return `<${
      context.parentType != null && context.parentType !== DEFAULT_MOCK_TYPENAME
        ? context.parentType + '-'
        : ''
    }mock-id-${generateId()}>`;
  },
  Boolean() {
    return false;
  },
  Int() {
    return 42;
  },
  Float() {
    return 4.2;
  },
};

const DEFAULT_MOCK_TYPENAME = '__MockObject';

/**
 * Basic value resolver
 */
function valueResolver(
  generateId: () => number,
  mockResolvers: ?MockResolvers,
  typeName: ?string,
  context: MockResolverContext,
  plural: ?boolean = false,
  defaultValue?: mixed,
): mixed {
  const generateValue = (possibleDefaultValue: mixed) => {
    let mockValue;
    const mockResolver =
      typeName != null && mockResolvers != null
        ? mockResolvers[typeName]
        : null;
    if (mockResolver != null) {
      mockValue = mockResolver(context, generateId);
    }
    if (mockValue === undefined) {
      mockValue =
        possibleDefaultValue ??
        `<mock-value-for-field-"${context.alias ??
          context.name ||
          'undefined'}">`;
    }
    return mockValue;
  };

  return plural === true
    ? generateMockList(
        Array.isArray(defaultValue) ? defaultValue : Array(1).fill(),
        generateValue,
      )
    : generateValue(defaultValue);
}

function createValueResolver(mockResolvers: ?MockResolvers): ValueResolver {
  const generateId = createIdGenerator();
  return (...args) => {
    return valueResolver(generateId, mockResolvers, ...args);
  };
}

function generateMockList<T>(
  placeholderArray: $ReadOnlyArray<mixed>,
  generateListItem: (defaultValue: mixed) => T,
): $ReadOnlyArray<T> {
  return placeholderArray.map(possibleDefaultValue =>
    generateListItem(possibleDefaultValue),
  );
}

class RelayMockPayloadGenerator {
  _variables: Variables;
  _resolveValue: ValueResolver;
  _mockResolvers: MockResolvers;
  _selectionMetadata: SelectionMetadata;

  constructor(options: {|
    +variables: Variables,
    +mockResolvers: MockResolvers | null,
    +selectionMetadata: SelectionMetadata | null,
  |}) {
    this._variables = options.variables;
    this._mockResolvers = {
      ...DEFAULT_MOCK_RESOLVERS,
      ...(options.mockResolvers ?? {}),
    };
    this._selectionMetadata = options.selectionMetadata ?? {};
    this._resolveValue = createValueResolver(this._mockResolvers);
  }

  generate(
    selections: $ReadOnlyArray<NormalizationSelection>,
    operationType: string,
  ): MockData {
    const defaultValues = this._getDefaultValuesForObject(
      operationType,
      null,
      null,
      [], // path
      {},
    );
    return this._traverse(
      {
        selections,
        typeName: operationType,
        isAbstractType: false,
        name: null,
        alias: null,
        args: null,
      },
      [], // path
      null, // prevData
      defaultValues,
    );
  }

  _traverse(
    traversable: Traversable,
    path: $ReadOnlyArray<string>,
    prevData: ?MockData,
    defaultValues: ?MockData,
  ): MockData {
    const {selections, typeName, isAbstractType} = traversable;

    return this._traverseSelections(
      selections,
      typeName,
      isAbstractType,
      path,
      prevData,
      defaultValues,
    );
  }

  /**
   * Generate mock values for selection of fields
   */
  _traverseSelections(
    selections: $ReadOnlyArray<NormalizationSelection>,
    typeName: ?string,
    isAbstractType: ?boolean,
    path: $ReadOnlyArray<string>,
    prevData: ?MockData,
    defaultValues: ?MockData,
  ): MockData {
    let mockData = prevData ?? {};

    selections.forEach(selection => {
      switch (selection.kind) {
        case SCALAR_FIELD: {
          mockData = this._mockScalar(
            selection,
            typeName,
            path,
            mockData,
            defaultValues,
          );
          break;
        }
        case LINKED_FIELD: {
          mockData = this._mockLink(selection, path, mockData, defaultValues);
          break;
        }
        case CONDITION:
          const conditionValue = this._getVariableValue(selection.condition);
          if (conditionValue === selection.passingValue) {
            mockData = this._traverseSelections(
              selection.selections,
              typeName,
              isAbstractType,
              path,
              mockData,
              defaultValues,
            );
          }
          break;

        case DEFER:
        case STREAM: {
          mockData = this._traverseSelections(
            selection.selections,
            typeName,
            isAbstractType,
            path,
            mockData,
            defaultValues,
          );
          break;
        }

        case INLINE_FRAGMENT: {
          // If it's the first time we're trying to handle fragment spread
          // on this selection, we will generate data for this type.
          // Next fragment spread on this selection will be added only if the
          // types are matching
          if (
            mockData != null &&
            (mockData[TYPENAME_KEY] == null ||
              mockData[TYPENAME_KEY] === DEFAULT_MOCK_TYPENAME)
          ) {
            mockData[TYPENAME_KEY] =
              defaultValues?.[TYPENAME_KEY] ?? selection.type;
          }
          // Now, we need to make sure that we don't select abstract type
          // for inline fragments
          if (
            isAbstractType === true &&
            mockData != null &&
            mockData[TYPENAME_KEY] === typeName
          ) {
            mockData[TYPENAME_KEY] = selection.type;
          }
          if (mockData != null && mockData[TYPENAME_KEY] === selection.type) {
            const defaults = this._getDefaultValuesForObject(
              selection.type,
              path[path.length - 1],
              null,
              path,
            );
            mockData = this._traverseSelections(
              selection.selections,
              selection.type,
              isAbstractType,
              path,
              mockData,
              defaults ?? defaultValues,
            );
            if (mockData[TYPENAME_KEY] != null) {
              mockData[TYPENAME_KEY] = selection.type;
            }

            // Make sure we're using id form the default values, an
            // ID may be referenced in the same selection as InlineFragment
            if (
              mockData.id != null &&
              defaults != null &&
              defaults.id != null
            ) {
              mockData.id = defaults.id;
            }
          }
          break;
        }
        case CLIENT_EXTENSION:
        case MODULE_IMPORT:
          // TODO(T41499100) We're currently not generating ClientExtension nodes
          // so we can skip for now
          // TODO(T43369419) generate payloads for 3D in mock payload generator
          break;
        case SCALAR_HANDLE:
        case LINKED_HANDLE:
          break;
        default:
          (selection: empty);
          invariant(
            false,
            'RelayMockPayloadGenerator(): Unexpected AST kind `%s`.',
            selection.kind,
          );
      }
    });
    return mockData;
  }

  /**
   * Generate mock value for a scalar field in the selection
   */
  _mockScalar(
    field: NormalizationScalarField,
    typeName: ?string,
    path: $ReadOnlyArray<string>,
    mockData: ?MockData,
    defaultValues: ?MockData,
  ): MockData {
    const data = mockData ?? {};
    const applicationName = field.alias ?? field.name;
    if (data.hasOwnProperty(applicationName) && field.name !== TYPENAME_KEY) {
      return data;
    }

    let value;

    // For __typename fields we are going to return typeName
    if (field.name === TYPENAME_KEY) {
      value = typeName ?? DEFAULT_MOCK_TYPENAME;
    }
    // We may have an object with default values (generated in _mockLink(...))
    // let's check if we have a value there for our field
    if (
      defaultValues != null &&
      defaultValues.hasOwnProperty(applicationName)
    ) {
      value = defaultValues[applicationName];
    }

    // If the value has not been generated yet (__id, __typename fields, or defaults)
    // then we need to generate mock value for a scalar type
    if (value === undefined) {
      const selectionPath = [...path, applicationName];
      // Get basic type information: type of the field (Int, Float, String, etc..)
      // And check if it's a plural type
      const {type, plural, enumValues} = this._getScalarFieldTypeDetails(
        field,
        typeName,
        selectionPath,
      );

      const defaultValue = enumValues != null ? enumValues[0] : undefined;

      value = this._resolveValue(
        // If we don't have schema let's assume that fields with name (id, __id)
        // have type ID
        type,
        {
          parentType: typeName,
          name: field.name,
          alias: field.alias,
          path: selectionPath,
          args: this._getFieldArgs(field),
        },
        plural,
        defaultValue,
      );
    }
    data[applicationName] = value;
    return data;
  }

  /**
   * Generate mock data for linked fields in the selection
   */
  _mockLink(
    field: NormalizationLinkedField,
    path: $ReadOnlyArray<string>,
    prevData: ?MockData,
    defaultValues: ?MockData,
  ): MockData | null {
    const applicationName = field.alias ?? field.name;
    const data = prevData ?? {};
    const args = this._getFieldArgs(field);

    // Let's check if we have a custom mock resolver for the object type
    // We will pass this data down to selection, so _mockScalar(...) can use
    // values from `defaults`
    const selectionPath = [...path, applicationName];
    const typeFromSelection = this._selectionMetadata[
      selectionPath.join('.')
    ] ?? {
      type: DEFAULT_MOCK_TYPENAME,
    };

    let defaults = this._getDefaultValuesForObject(
      field.concreteType ?? typeFromSelection.type,
      field.name,
      field.alias,
      selectionPath,
      args,
    );
    if (
      defaults == null &&
      defaultValues != null &&
      typeof defaultValues[applicationName] === 'object'
    ) {
      defaults = defaultValues[applicationName];
    }

    // In cases when we have explicit `null` in the defaults - let's return
    // null for full branch
    if (defaults === null) {
      data[applicationName] = null;
      return data;
    }

    // If concrete type is null, let's try to get if from defaults,
    // and fallback to default object type
    const typeName =
      field.concreteType ??
      (defaults != null && typeof defaults[TYPENAME_KEY] === 'string'
        ? defaults[TYPENAME_KEY]
        : typeFromSelection.type);

    // Let's assume, that if the concrete type is null and selected type name is
    // different from type information form selection, most likely this type
    // information came from mock resolver __typename value and it was
    // an intentional selection of the specific type
    const isAbstractType =
      field.concreteType === null && typeName === typeFromSelection.type;

    const generateDataForField = possibleDefaultValue => {
      if (possibleDefaultValue === null) {
        return null;
      }
      return this._traverse(
        {
          selections: field.selections,
          typeName,
          isAbstractType: isAbstractType,
          name: field.name,
          alias: field.alias,
          args,
        },
        [...path, applicationName],
        /* $FlowFixMe(>=0.98.0 site=react_native_fb,oss) This comment suppresses an
         * error found when Flow v0.98 was deployed. To see the error delete
         * this comment and run Flow. */
        typeof data[applicationName] === 'object'
          ? data[applicationName]
          : null,
        /* $FlowFixMe(>=0.98.0 site=react_native_fb,oss) This comment suppresses an
         * error found when Flow v0.98 was deployed. To see the error delete
         * this comment and run Flow. */
        possibleDefaultValue,
      );
    };

    data[applicationName] = field.plural
      ? generateMockList(
          Array.isArray(defaults) ? defaults : Array(1).fill(),
          generateDataForField,
        )
      : generateDataForField(defaults);

    return data;
  }

  /**
   * Get the value for a variable by name
   */
  _getVariableValue(name: string): mixed {
    invariant(
      this._variables.hasOwnProperty(name),
      'RelayMockPayloadGenerator(): Undefined variable `%s`.',
      name,
    );
    return this._variables[name];
  }

  /**
   * This method should call mock resolver for a specific type name
   * and the result of this mock resolver will be passed as a default values for
   * _mock*(...) methods
   */
  _getDefaultValuesForObject(
    typeName: ?string,
    fieldName: ?string,
    fieldAlias: ?string,
    path: $ReadOnlyArray<string>,
    args: ?{
      [string]: mixed,
    },
  ): ?MockData {
    let data;
    if (typeName != null && this._mockResolvers[typeName] != null) {
      data = this._resolveValue(
        typeName,
        {
          parentType: null,
          name: fieldName,
          alias: fieldAlias,
          args,
          path,
        },
        false,
      );
    }
    if (typeof data === 'object') {
      /* $FlowFixMe(>=0.98.0 site=react_native_fb,oss) This comment suppresses an
       * error found when Flow v0.98 was deployed. To see the error delete this
       * comment and run Flow. */
      return data;
    }
  }

  /**
   * Get object with variables for field
   */
  _getFieldArgs(
    field: NormalizationLinkedField | NormalizationScalarField,
  ): {
    [string]: mixed,
  } {
    const args = {};
    if (field.args != null) {
      field.args.forEach(arg => {
        args[arg.name] =
          arg.kind === 'Literal'
            ? arg.value
            : this._getVariableValue(arg.variableName);
      });
    }
    return args;
  }

  /**
   * Helper function to get field type information (name of the type, plural)
   */
  _getScalarFieldTypeDetails(
    field: NormalizationScalarField,
    typeName: ?string,
    selectionPath: $ReadOnlyArray<string>,
  ): {|
    +type: string,
    +plural: boolean,
    +enumValues: $ReadOnlyArray<string> | null,
    +nullable: boolean,
  |} {
    return (
      this._selectionMetadata[selectionPath.join('.')] ?? {
        type: field.name === 'id' ? 'ID' : 'String',
        plural: false,
        enumValues: null,
        nullable: false,
      }
    );
  }
}

/**
 * Generate mock data for NormalizationOperation selection
 */
function generateData(
  node: NormalizationOperation,
  variables: Variables,
  mockResolvers: MockResolvers | null,
  selectionMetadata: SelectionMetadata | null,
): MockData {
  const mockGenerator = new RelayMockPayloadGenerator({
    variables,
    mockResolvers,
    selectionMetadata,
  });
  let operationType;
  if (node.name.endsWith('Mutation')) {
    operationType = 'Mutation';
  } else if (node.name.endsWith('Subscription')) {
    operationType = 'Subscription';
  } else {
    operationType = 'Query';
  }
  return mockGenerator.generate(node.selections, operationType);
}

/**
 * Type refinement for selection metadata
 */
function getSelectionMetadataFromOperation(
  operation: OperationDescriptor,
): SelectionMetadata | null {
  const selectionTypeInfo =
    operation.node.params.metadata?.relayTestingSelectionTypeInfo;
  if (
    selectionTypeInfo != null &&
    !Array.isArray(selectionTypeInfo) &&
    typeof selectionTypeInfo === 'object'
  ) {
    const selectionMetadata: SelectionMetadata = {};
    Object.keys(selectionTypeInfo).forEach(path => {
      const item = selectionTypeInfo[path];
      if (item != null && !Array.isArray(item) && typeof item === 'object') {
        if (
          typeof item.type === 'string' &&
          typeof item.plural === 'boolean' &&
          typeof item.nullable === 'boolean' &&
          (item.enumValues === null || Array.isArray(item.enumValues))
        ) {
          selectionMetadata[path] = {
            type: item.type,
            plural: item.plural,
            nullable: item.nullable,
            enumValues: Array.isArray(item.enumValues)
              ? item.enumValues.map(String)
              : null,
          };
        }
      }
    });
    return selectionMetadata;
  }
  return null;
}

function generateDataForOperation(
  operation: OperationDescriptor,
  mockResolvers: ?MockResolvers,
): GraphQLResponse {
  const data = generateData(
    operation.node.operation,
    operation.variables,
    mockResolvers ?? null,
    getSelectionMetadataFromOperation(operation),
  );
  return {data};
}

module.exports = {
  generate: generateDataForOperation,
};
