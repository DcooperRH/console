import * as React from 'react';
import { sortable } from '@patternfly/react-table';
import * as classNames from 'classnames';
import { JSONSchema7 } from 'json-schema';
import * as _ from 'lodash';
import { useTranslation } from 'react-i18next';
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore: FIXME missing exports due to out-of-sync @types/react-redux version
import { useDispatch } from 'react-redux';
import { useHistory, match } from 'react-router-dom';
import { ListPageBody } from '@console/dynamic-plugin-sdk';
import { getResources } from '@console/internal/actions/k8s';
import { Conditions } from '@console/internal/components/conditions';
import { ErrorPage404 } from '@console/internal/components/error';
import { ResourceEventStream } from '@console/internal/components/events';
import {
  DetailsPage,
  Table,
  TableData,
  RowFunctionArgs,
  Flatten,
  Filter,
} from '@console/internal/components/factory';
import { useListPageFilter } from '@console/internal/components/factory/ListPage/filter-hook';
import {
  ListPageCreateDropdown,
  ListPageCreateLink,
} from '@console/internal/components/factory/ListPage/ListPageCreate';
import ListPageFilter from '@console/internal/components/factory/ListPage/ListPageFilter';
import ListPageHeader from '@console/internal/components/factory/ListPage/ListPageHeader';
import { deleteModal } from '@console/internal/components/modals';
import {
  Kebab,
  KebabAction,
  LabelList,
  MsgBox,
  ResourceKebab,
  ResourceSummary,
  SectionHeading,
  Timestamp,
  navFactory,
  ResourceLink,
} from '@console/internal/components/utils';
import {
  useK8sWatchResources,
  useK8sWatchResource,
} from '@console/internal/components/utils/k8s-watch-hook';
import { connectToModel } from '@console/internal/kinds';
import { CustomResourceDefinitionModel } from '@console/internal/models';
import {
  GroupVersionKind,
  K8sKind,
  K8sResourceCondition,
  K8sResourceKind,
  K8sResourceKindReference,
  OwnerReference,
  apiGroupForReference,
  apiVersionForReference,
  kindForReference,
  referenceFor,
  referenceForModel,
  nameForModel,
  CustomResourceDefinitionKind,
  definitionFor,
  K8sResourceCommon,
} from '@console/internal/module/k8s';
import {
  ClusterServiceVersionAction,
  useExtensions,
  isClusterServiceVersionAction,
} from '@console/plugin-sdk';
import { Status, SuccessStatus, getNamespace } from '@console/shared';
import ErrorAlert from '@console/shared/src/components/alerts/error';
import { useK8sModel } from '@console/shared/src/hooks/useK8sModel';
import { useK8sModels } from '@console/shared/src/hooks/useK8sModels';
import { ClusterServiceVersionModel } from '../../models';
import { ClusterServiceVersionKind, ProvidedAPI } from '../../types';
import { DescriptorDetailsItem, DescriptorDetailsItemList } from '../descriptors';
import { DescriptorConditions } from '../descriptors/status/conditions';
import { DescriptorType, StatusCapability, StatusDescriptor } from '../descriptors/types';
import { isMainStatusDescriptor } from '../descriptors/utils';
import { providedAPIsForCSV, referenceForProvidedAPI } from '../index';
import { Resources } from '../k8s-resource';
import ModelStatusBox from '../model-status-box';
import { csvNameFromWindow, OperandLink } from './operand-link';
import { ShowOperandsInAllNamespacesRadioGroup } from './ShowOperandsInAllNamespacesRadioGroup';
import { useShowOperandsInAllNamespaces } from './useShowOperandsInAllNamespaces';

/**
 * @depricated these actions has been converted to Action extension, src/actions/csv-actions.ts
 */

export const getOperandActions = (
  ref: K8sResourceKindReference,
  actionExtensions: ClusterServiceVersionAction[],
  csvName?: string,
) => {
  const actions = actionExtensions.filter(
    (action) =>
      action.properties.kind === kindForReference(ref) &&
      apiGroupForReference(ref) === action.properties.apiGroup,
  );
  const pluginActions = actions.reduce((acc, action) => {
    acc[action.properties.id] = (kind, ocsObj) => ({
      label: action.properties.label,
      callback: action.properties.callback(kind, ocsObj),
      hidden:
        typeof action.properties?.hidden === 'function'
          ? action.properties?.hidden(kind, ocsObj)
          : action.properties?.hidden,
    });
    return acc;
  }, {});
  const defaultActions = {
    edit: (kind, obj) => {
      const reference = referenceFor(obj);
      const href = kind.namespaced
        ? `/k8s/ns/${obj.metadata.namespace}/${ClusterServiceVersionModel.plural}/${csvName ||
            csvNameFromWindow()}/${reference}/${obj.metadata.name}/yaml`
        : `/k8s/cluster/${reference}/${obj.metadata.name}/yaml`;
      return {
        // t('olm~Edit {{item}}')
        labelKey: 'olm~Edit {{item}}',
        labelKind: { item: kind.label },
        href,
        accessReview: {
          group: kind.apiGroup,
          resource: kind.plural,
          name: obj.metadata.name,
          namespace: obj.metadata.namespace,
          verb: 'update',
        },
      };
    },
    delete: (kind, obj) => ({
      // t('olm~Delete {{item}}')
      labelKey: 'olm~Delete {{item}}',
      labelKind: { item: kind.label },
      callback: () =>
        deleteModal({
          kind,
          resource: obj,
          redirectTo: `/k8s/ns/${obj.metadata.namespace}/${
            ClusterServiceVersionModel.plural
          }/${csvName || csvNameFromWindow()}/${referenceFor(obj)}`,
        }),
      accessReview: {
        group: kind.apiGroup,
        resource: kind.plural,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
        verb: 'delete',
      },
    }),
  };
  // In order to keep plugin properties on top
  const overridenProperties = Object.assign(
    defaultActions,
    _.pick(pluginActions, Object.keys(defaultActions)),
  );
  const mergedActions = Object.assign({}, pluginActions, overridenProperties);
  return Object.values(mergedActions) as KebabAction[];
};

const tableColumnClasses = [
  '',
  '',
  '',
  classNames('pf-m-hidden', 'pf-m-visible-on-sm', 'pf-u-w-16-on-lg'),
  classNames('pf-m-hidden', 'pf-m-visible-on-xl'),
  classNames('pf-m-hidden', 'pf-m-visible-on-2xl'),
  Kebab.columnClass,
];

const getOperandStatus = (obj: K8sResourceKind): OperandStatusType => {
  const { phase, status, state, conditions } = obj?.status || {};

  if (phase && _.isString(phase)) {
    return {
      type: 'Phase',
      value: phase,
    };
  }

  if (status && _.isString(status)) {
    return {
      type: 'Status',
      value: status,
    };
  }

  if (state && _.isString(state)) {
    return {
      type: 'State',
      value: state,
    };
  }

  const trueConditions = conditions?.filter((c: K8sResourceCondition) => c.status === 'True');
  if (trueConditions?.length) {
    const types = trueConditions.map((c: K8sResourceCondition) => c.type);
    return {
      type: types.length === 1 ? 'Condition' : 'Conditions',
      value: types.join(', '),
    };
  }

  return null;
};

const hasAllNamespaces = (csv: ClusterServiceVersionKind) => {
  const olmTargetNamespaces = csv?.metadata?.annotations?.['olm.targetNamespaces'] ?? '';
  const managedNamespaces = olmTargetNamespaces?.split(',') || [];
  return managedNamespaces.length === 1 && managedNamespaces[0] === '';
};

export const OperandStatus: React.FC<OperandStatusProps> = ({ operand }) => {
  const status: OperandStatusType = getOperandStatus(operand);
  if (!status) {
    return <>-</>;
  }

  const { type, value } = status;
  return (
    <span className="co-icon-and-text">
      {type}: {value === 'Running' ? <SuccessStatus title={value} /> : <Status status={value} />}
    </span>
  );
};

const getOperandStatusText = (operand: K8sResourceKind): string => {
  const status = getOperandStatus(operand);
  return status ? `${status.type}: ${status.value}` : '';
};

export const OperandTableRow: React.FC<OperandTableRowProps> = ({ obj, showNamespace }) => {
  const actionExtensions = useExtensions<ClusterServiceVersionAction>(
    isClusterServiceVersionAction,
  );
  const objReference = referenceFor(obj);
  const actions = React.useMemo(() => getOperandActions(objReference, actionExtensions), [
    objReference,
    actionExtensions,
  ]);

  return (
    <>
      <TableData className={tableColumnClasses[0]}>
        <OperandLink obj={obj} />
      </TableData>
      <TableData
        className={classNames(tableColumnClasses[1], 'co-break-word')}
        data-test-operand-kind={obj.kind}
      >
        {obj.kind}
      </TableData>
      {showNamespace && (
        <TableData className={tableColumnClasses[2]}>
          {obj.metadata.namespace ? (
            <ResourceLink
              kind="Namespace"
              title={obj.metadata.namespace}
              name={obj.metadata.namespace}
            />
          ) : (
            '-'
          )}
        </TableData>
      )}
      <TableData className={tableColumnClasses[3]}>
        <OperandStatus operand={obj} />
      </TableData>
      <TableData className={tableColumnClasses[4]}>
        <LabelList kind={obj.kind} labels={obj.metadata.labels} />
      </TableData>
      <TableData className={tableColumnClasses[5]}>
        <Timestamp timestamp={obj.metadata.creationTimestamp} />
      </TableData>
      <TableData className={tableColumnClasses[6]}>
        <ResourceKebab actions={actions} kind={referenceFor(obj)} resource={obj} />
      </TableData>
    </>
  );
};

const getOperandNamespace = (obj: ClusterServiceVersionKind): string | null => getNamespace(obj);

export const OperandList: React.FC<OperandListProps> = (props) => {
  const { t } = useTranslation();
  const { noAPIsFound, showNamespace } = props;

  const nameHeader: Header = {
    title: t('public~Name'),
    sortField: 'metadata.name',
    transforms: [sortable],
    props: { className: tableColumnClasses[0] },
  };
  const kindHeader: Header = {
    title: t('public~Kind'),
    sortField: 'kind',
    transforms: [sortable],
    props: { className: tableColumnClasses[1] },
  };
  const namespaceHeader: Header = {
    title: t('public~Namespace'),
    sortFunc: 'getOperandNamespace',
    transforms: [sortable],
    props: { className: tableColumnClasses[2] },
  };
  const statusHeader: Header = {
    title: t('public~Status'),
    sortFunc: 'operandStatus',
    transforms: [sortable],
    props: { className: tableColumnClasses[3] },
  };
  const labelsHeader: Header = {
    title: t('public~Labels'),
    sortField: 'metadata.labels',
    transforms: [sortable],
    props: { className: tableColumnClasses[4] },
  };
  const lastUpdatedHeader: Header = {
    title: t('public~Last updated'),
    sortField: 'metadata.creationTimestamp',
    transforms: [sortable],
    props: { className: tableColumnClasses[5] },
  };
  const kebabHeader: Header = {
    title: '',
    props: { className: tableColumnClasses[6] },
  };

  const AllNsHeader = (): Header[] => [
    nameHeader,
    kindHeader,
    namespaceHeader,
    statusHeader,
    labelsHeader,
    lastUpdatedHeader,
    kebabHeader,
  ];
  const CurrentNsHeader = (): Header[] => [
    nameHeader,
    kindHeader,
    statusHeader,
    labelsHeader,
    lastUpdatedHeader,
    kebabHeader,
  ];

  const data = React.useMemo(
    () =>
      props.data?.map?.((obj) => {
        if (obj.apiVersion && obj.kind) {
          return obj;
        }
        const reference = props.kinds[0];
        return {
          apiVersion: apiVersionForReference(reference),
          kind: kindForReference(reference),
          ...obj,
        };
      }) ?? [],
    [props.data, props.kinds],
  );

  return (
    <Table
      {...props}
      customSorts={{
        operandStatus: getOperandStatusText,
        getOperandNamespace,
      }}
      data={data}
      EmptyMsg={() =>
        noAPIsFound ? (
          <MsgBox
            title={t('olm~No provided APIs defined')}
            detail={t('olm~This application was not properly installed or configured.')}
          />
        ) : (
          <MsgBox
            title={t('olm~No operands found')}
            detail={t(
              'olm~Operands are declarative components used to define the behavior of the application.',
            )}
          />
        )
      }
      aria-label="Operands"
      Header={showNamespace ? AllNsHeader : CurrentNsHeader}
      Row={(listProps) => <OperandTableRow {...listProps} showNamespace={showNamespace} />}
      virtualize
    />
  );
};

const getK8sWatchResources = (
  models: ProvidedAPIModels,
  providedAPIs: ProvidedAPI[],
  namespace?: string,
): GetK8sWatchResources => {
  return providedAPIs.reduce((resourceAccumulator, api) => {
    const reference = referenceForProvidedAPI(api);
    const model = models?.[reference];

    if (!model) {
      return resourceAccumulator;
    }

    const { apiGroup: group, apiVersion: version, kind, namespaced } = model;
    return {
      ...resourceAccumulator,
      [api.kind]: {
        groupVersionKind: { group, version, kind },
        isList: true,
        namespaced,
        ...(namespaced && namespace ? { namespace } : {}),
      },
    };
  }, {});
};

export const ProvidedAPIsPage = (props: ProvidedAPIsPageProps) => {
  const { t } = useTranslation();
  const [showOperandsInAllNamespaces] = useShowOperandsInAllNamespaces();
  const {
    obj,
    showTitle = true,
    hideLabelFilter = false,
    hideNameLabelFilters = false,
    hideColumnManagement = false,
  } = props;
  const [models, inFlight] = useK8sModels();
  const history = useHistory();
  const dispatch = useDispatch();
  const [apiRefreshed, setAPIRefreshed] = React.useState(false);

  // Map APIs provided by this CSV to Firehose resources. Exclude APIs that do not have a model.
  const providedAPIs = providedAPIsForCSV(obj);

  const owners = (ownerRefs: OwnerReference[], items: K8sResourceKind[]) =>
    ownerRefs.filter(({ uid }) => items.filter(({ metadata }) => metadata.uid === uid).length > 0);
  const flatten: Flatten<{
    [key: string]: K8sResourceCommon[];
  }> = React.useCallback(
    (resources) =>
      _.flatMap(resources, (resource) => _.map(resource.data, (item) => item)).filter(
        ({ kind, metadata }, i, allResources) =>
          providedAPIs.filter((item) => item.kind === kind).length > 0 ||
          owners(metadata.ownerReferences || [], allResources).length > 0,
      ),
    [providedAPIs],
  );

  const hasNamespacedAPI = providedAPIs.some((api) => {
    const reference = referenceForProvidedAPI(api);
    const model = models[reference];

    return model?.namespaced;
  });

  const managesAllNamespaces = hasNamespacedAPI && hasAllNamespaces(obj);
  const listAllNamespaces = managesAllNamespaces && showOperandsInAllNamespaces;
  const watchedResources = getK8sWatchResources(
    models,
    providedAPIs,
    listAllNamespaces ? null : obj.metadata.namespace,
  );

  const resources = useK8sWatchResources<{ [key: string]: K8sResourceKind[] }>(watchedResources);

  // Refresh API definitions if at least one API is missing a model and definitions have not already been refreshed.
  const apiMightBeOutdated =
    !inFlight && Object.keys(watchedResources).length < providedAPIs.length;
  React.useEffect(() => {
    if (!apiRefreshed && apiMightBeOutdated) {
      dispatch(getResources());
      setAPIRefreshed(true);
    }
  }, [apiMightBeOutdated, apiRefreshed, dispatch]);

  const createItems =
    providedAPIs.length > 1
      ? providedAPIs.reduce((acc, api) => ({ ...acc, [api.name]: api.displayName }), {})
      : {};

  const createNavigate = (name) =>
    history.push(
      `/k8s/ns/${obj.metadata.namespace}/${ClusterServiceVersionModel.plural}/${
        obj.metadata.name
      }/${referenceForProvidedAPI(_.find(providedAPIs, { name }))}/~new`,
    );

  const data = React.useMemo(() => flatten(resources), [resources, flatten]);

  const rowFilters =
    Object.keys(watchedResources).length > 1
      ? [
          {
            filterGroupName: t('olm~Resource Kind'),
            type: 'clusterserviceversion-resource-kind',
            reducer: ({ kind }) => kind,
            items: Object.keys(watchedResources).map((kind) => ({
              id: kindForReference(kind),
              title: kindForReference(kind),
            })),
            filter: (filters, resource) => {
              if (!filters || !filters.selected || !filters.selected.length) {
                return true;
              }
              return filters.selected.includes(resource.kind);
            },
          },
        ]
      : [];

  const [staticData, filteredData, onFilterChange] = useListPageFilter(data, rowFilters);
  const loaded = Object.values(resources).every((r) => r.loaded);
  const loadErrors = Object.values(resources)
    .filter((r) => r.loadError)
    .map((m) => m.loadError)
    .join();

  return inFlight ? null : (
    <>
      <ListPageHeader title={showTitle ? t('olm~All Instances') : undefined}>
        {managesAllNamespaces && (
          <div className="co-operator-details__toggle-value pf-u-ml-xl-on-md">
            <ShowOperandsInAllNamespacesRadioGroup />
          </div>
        )}
        <ListPageCreateDropdown onClick={createNavigate} items={createItems}>
          {t('olm~Create new')}
        </ListPageCreateDropdown>
      </ListPageHeader>
      <ListPageBody>
        <ListPageFilter
          data={staticData}
          loaded={loaded}
          rowFilters={rowFilters}
          onFilterChange={onFilterChange}
          hideNameLabelFilters={hideNameLabelFilters}
          hideLabelFilter={hideLabelFilter}
          hideColumnManagement={hideColumnManagement}
        />
        <OperandList
          data={filteredData}
          loaded={loaded}
          loadError={loadErrors}
          noAPIsFound={Object.keys(watchedResources).length === 0}
          showNamespace={listAllNamespaces}
        />
      </ListPageBody>
    </>
  );
};

export const ProvidedAPIPage: React.FC<ProvidedAPIPageProps> = (props) => {
  const { t } = useTranslation();
  const [showOperandsInAllNamespaces] = useShowOperandsInAllNamespaces();

  const {
    namespace,
    kind: apiGroupVersionKind,
    csv,
    showTitle = true,
    hideLabelFilter = false,
    hideNameLabelFilters = false,
    hideColumnManagement = false,
  } = props;
  const createPath = `/k8s/ns/${csv.metadata.namespace}/${ClusterServiceVersionModel.plural}/${csv.metadata.name}/${apiGroupVersionKind}/~new`;
  const [model, inFlight] = useK8sModel(apiGroupVersionKind);
  const [apiRefreshed, setAPIRefreshed] = React.useState(false);
  const dispatch = useDispatch();

  // Refresh API definitions if model is missing and the definitions have not already been refreshed.
  const apiMightBeOutdated = !inFlight && !model;
  React.useEffect(() => {
    if (!apiRefreshed && apiMightBeOutdated) {
      dispatch(getResources());
      setAPIRefreshed(true);
    }
  }, [dispatch, apiRefreshed, apiMightBeOutdated]);

  const { apiGroup: group, apiVersion: version, kind, namespaced, label } = model ?? {};
  const managesAllNamespaces = namespaced && hasAllNamespaces(csv);
  const listAllNamespaces = managesAllNamespaces && showOperandsInAllNamespaces;
  const [resources, loaded, loadError] = useK8sWatchResource<K8sResourceKind[]>(
    model
      ? {
          groupVersionKind: { group, version, kind },
          isList: true,
          namespaced,
          ...(!listAllNamespaces && namespaced && namespace ? { namespace } : {}),
        }
      : {},
  );

  const [staticData, filteredData, onFilterChange] = useListPageFilter(resources);

  return (
    <ModelStatusBox groupVersionKind={apiGroupVersionKind}>
      <ListPageHeader title={showTitle ? `${label}s` : undefined}>
        {managesAllNamespaces && (
          <div className="co-operator-details__toggle-value pf-u-ml-xl-on-md">
            <ShowOperandsInAllNamespacesRadioGroup />
          </div>
        )}
        <ListPageCreateLink to={createPath}>
          {t('public~Create {{label}}', { label })}
        </ListPageCreateLink>
      </ListPageHeader>
      <ListPageBody>
        <ListPageFilter
          data={staticData}
          loaded={loaded}
          onFilterChange={onFilterChange}
          hideNameLabelFilters={hideNameLabelFilters}
          hideLabelFilter={hideLabelFilter}
          hideColumnManagement={hideColumnManagement}
        />
        <OperandList
          data={filteredData}
          loaded={loaded}
          loadError={loadError}
          showNamespace={listAllNamespaces}
        />
      </ListPageBody>
    </ModelStatusBox>
  );
};

const OperandDetailsSection: React.FC = ({ children }) => (
  <div className="co-operand-details__section co-operand-details__section--info">{children}</div>
);

const PodStatuses: React.FC<PodStatusesProps> = ({ kindObj, obj, podStatusDescriptors, schema }) =>
  podStatusDescriptors?.length > 0 ? (
    <div className="row">
      {podStatusDescriptors.map((statusDescriptor: StatusDescriptor) => {
        return (
          <DescriptorDetailsItem
            className="col-sm-6"
            key={statusDescriptor.path}
            type={DescriptorType.status}
            descriptor={statusDescriptor}
            model={kindObj}
            obj={obj}
            schema={schema}
          />
        );
      })}
    </div>
  ) : null;

export const OperandDetails = connectToModel(({ crd, csv, kindObj, obj }: OperandDetailsProps) => {
  const { t } = useTranslation();
  const { kind, status } = obj;
  const [errorMessage, setErrorMessage] = React.useState(null);
  const handleError = (err: Error) => setErrorMessage(err.message);

  // Find the matching CRD spec for the kind of this resource in the CSV.
  const { displayName, specDescriptors, statusDescriptors, version } =
    [
      ...(csv?.spec?.customresourcedefinitions?.owned ?? []),
      ...(csv?.spec?.customresourcedefinitions?.required ?? []),
    ].find((def) => def.name === crd?.metadata?.name) ?? {};

  const schema =
    crd?.spec?.versions?.find((v) => v.name === version)?.schema?.openAPIV3Schema ??
    (definitionFor(kindObj) as JSONSchema7);

  const {
    podStatuses,
    mainStatusDescriptor,
    conditionsStatusDescriptors,
    otherStatusDescriptors,
  } = (statusDescriptors ?? []).reduce((acc, descriptor) => {
    if (isMainStatusDescriptor(descriptor)) {
      return {
        ...acc,
        mainStatusDescriptor: descriptor,
      };
    }

    if (
      descriptor['x-descriptors']?.includes(StatusCapability.conditions) ||
      descriptor.path === 'conditions'
    ) {
      return {
        ...acc,
        conditionsStatusDescriptors: [...(acc.conditionsStatusDescriptors ?? []), descriptor],
      };
    }

    if (descriptor['x-descriptors']?.includes(StatusCapability.podStatuses)) {
      return {
        ...acc,
        podStatuses: [...(acc.podStatuses ?? []), descriptor],
      };
    }

    return {
      ...acc,
      otherStatusDescriptors: [...(acc.otherStatusDescriptors ?? []), descriptor],
    };
  }, {} as any);

  return (
    <div className="co-operand-details co-m-pane">
      <div className="co-m-pane__body">
        {errorMessage && <ErrorAlert message={errorMessage} />}
        <SectionHeading text={t('olm~{{kind}} overview', { kind: displayName || kind })} />
        <PodStatuses
          kindObj={kindObj}
          obj={obj}
          schema={schema}
          podStatusDescriptors={podStatuses}
        />
        <div className="co-operand-details__section co-operand-details__section--info">
          <div className="row">
            <div className="col-sm-6">
              <ResourceSummary resource={obj} />
            </div>
            {mainStatusDescriptor && (
              <DescriptorDetailsItem
                key={mainStatusDescriptor.path}
                className="col-sm-6"
                descriptor={mainStatusDescriptor}
                model={kindObj}
                obj={obj}
                schema={schema}
                type={DescriptorType.status}
              />
            )}
            {otherStatusDescriptors?.length > 0 && (
              <DescriptorDetailsItemList
                descriptors={otherStatusDescriptors}
                itemClassName="col-sm-6"
                model={kindObj}
                obj={obj}
                schema={schema}
                type={DescriptorType.status}
              />
            )}
          </div>
        </div>
      </div>
      {!_.isEmpty(specDescriptors) && (
        <div className="co-m-pane__body">
          <div className="co-operand-details__section co-operand-details__section--info">
            <div className="row">
              <DescriptorDetailsItemList
                descriptors={specDescriptors}
                itemClassName="col-sm-6"
                model={kindObj}
                obj={obj}
                onError={handleError}
                schema={schema}
                type={DescriptorType.spec}
              />
            </div>
          </div>
        </div>
      )}
      {Array.isArray(status?.conditions) &&
        (conditionsStatusDescriptors ?? []).every(({ path }) => path !== 'conditions') && (
          <div className="co-m-pane__body" data-test="status.conditions">
            <SectionHeading data-test="operand-conditions-heading" text={t('public~Conditions')} />
            <Conditions conditions={status.conditions} />
          </div>
        )}
      {conditionsStatusDescriptors?.length > 0 &&
        conditionsStatusDescriptors.map((descriptor) => (
          <DescriptorConditions
            key={descriptor.path}
            descriptor={descriptor}
            schema={schema}
            obj={obj}
          />
        ))}
    </div>
  );
});

const ResourcesTab = (resourceProps) => (
  <Resources {...resourceProps} clusterServiceVersion={resourceProps.csv} />
);

export const OperandDetailsPage = (props: OperandDetailsPageProps) => {
  const { t } = useTranslation();
  const [model] = useK8sModel(props.match.params.plural);
  const actionExtensions = useExtensions<ClusterServiceVersionAction>(
    isClusterServiceVersionAction,
  );
  const menuActions = React.useMemo(
    () => getOperandActions(props.match.params.plural, actionExtensions),
    [props.match.params.plural, actionExtensions],
  );

  return model ? (
    <DetailsPage
      match={props.match}
      name={props.match.params.name}
      kind={props.match.params.plural}
      namespace={props.match.params.ns}
      resources={[
        {
          kind: referenceForModel(ClusterServiceVersionModel),
          name: props.match.params.appName,
          namespace: props.match.params.ns,
          isList: false,
          prop: 'csv',
        },
        {
          kind: CustomResourceDefinitionModel.kind,
          name: nameForModel(model),
          isList: false,
          prop: 'crd',
        },
      ]}
      menuActions={menuActions}
      createRedirect
      breadcrumbsFor={() => [
        {
          name: t('olm~Installed Operators'),
          path: `/k8s/ns/${props.match.params.ns}/${ClusterServiceVersionModel.plural}`,
        },
        {
          name: props.match.params.appName,
          path: props.match.url.slice(0, props.match.url.lastIndexOf('/')),
        },
        {
          name: t('olm~{{item}} details', { item: kindForReference(props.match.params.plural) }), // Use url param in case model doesn't exist
          path: `${props.match.url}`,
        },
      ]}
      pages={[
        navFactory.details((detailsProps) => (
          <OperandDetails {...detailsProps} appName={props.match.params.appName} />
        )),
        navFactory.editYaml(),
        {
          name: t('olm~Resources'),
          href: 'resources',
          component: ResourcesTab,
        },
        navFactory.events(ResourceEventStream),
      ]}
    />
  ) : (
    <ErrorPage404 />
  );
};

type OperandStatusType = {
  type: string;
  value: string;
};

export type OperandListProps = {
  loaded: boolean;
  kinds?: GroupVersionKind[];
  data: K8sResourceKind[];
  filters?: Filter[];
  reduxID?: string;
  reduxIDs?: string[];
  rowSplitter?: any;
  staticFilters?: any;
  loadError?: string;
  noAPIsFound?: boolean;
  showNamespace?: boolean;
};

export type OperandStatusProps = {
  operand: K8sResourceKind;
};

export type OperandHeaderProps = {
  data: K8sResourceKind[];
};

export type OperandRowProps = {
  obj: K8sResourceKind;
};

export type ProvidedAPIsPageProps = {
  obj: ClusterServiceVersionKind;
  inFlight?: boolean;
  showTitle?: boolean;
  hideLabelFilter?: boolean;
  hideNameLabelFilters?: boolean;
  hideColumnManagement?: boolean;
};

export type ProvidedAPIPageProps = {
  csv: ClusterServiceVersionKind;
  kind: GroupVersionKind;
  namespace: string;
  showTitle?: boolean;
  hideLabelFilter?: boolean;
  hideNameLabelFilters?: boolean;
  hideColumnManagement?: boolean;
};

type PodStatusesProps = {
  kindObj: K8sKind;
  obj: K8sResourceKind;
  podStatusDescriptors: StatusDescriptor[];
  schema?: JSONSchema7;
};

export type OperandDetailsProps = {
  obj: K8sResourceKind;
  appName: string;
  kindObj: K8sKind;
  csv: ClusterServiceVersionKind;
  crd: CustomResourceDefinitionKind;
};

export type OperandDetailsPageProps = {
  match: match<{
    name: string;
    ns: string;
    appName: string;
    plural: string;
  }>;
};

export type OperandesourceDetailsProps = {
  csv?: { data: ClusterServiceVersionKind };
  gvk: GroupVersionKind;
  name: string;
  namespace: string;
  match: match<{ appName: string }>;
};

type Header = {
  title: string;
  sortField?: string;
  sortFunc?: string;
  transforms?: any;
  props: { className: string };
};

export type OperandTableRowProps = RowFunctionArgs<K8sResourceKind> & {
  showNamespace?: boolean;
};

type ProvidedAPIModels = { [key: string]: K8sKind };

type GetK8sWatchResources = {
  [key: string]: {
    kind: string;
    isList: boolean;
    namespace?: string;
    namespaced?: boolean;
  };
};
// TODO(alecmerdler): Find Webpack loader/plugin to add `displayName` to React components automagically
OperandList.displayName = 'OperandList';
OperandDetails.displayName = 'OperandDetails';
ProvidedAPIsPage.displayName = 'ProvidedAPIsPage';
OperandDetailsPage.displayName = 'OperandDetailsPage';
OperandTableRow.displayName = 'OperandTableRow';
OperandDetailsSection.displayName = 'OperandDetailsSection';
PodStatuses.displayName = 'PodStatuses';
