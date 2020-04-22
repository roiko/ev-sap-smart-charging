import Axios from 'axios';
import moment from 'moment';
import BackendError from '../../../exception/BackendError';
import { Action } from '../../../types/Authorization';
import { ChargingProfile, ChargingProfileKindType, ChargingProfilePurposeType, ChargingRateUnitType, ChargingSchedule, Profile } from '../../../types/ChargingProfile';
import { Connector } from '../../../types/ChargingStation';
import { ChargePointStatus } from '../../../types/ocpp/OCPPServer';
import { OptimizerCar, OptimizerCarAssignment, OptimizerChargingProfilesRequest, OptimizerChargingStation, OptimizerEvent, OptimizerFuse, OptimizerFuseTree, OptimizerResult, OptimizerState } from '../../../types/Optimizer';
import { SapSmartChargingSetting } from '../../../types/Setting';
import SiteArea from '../../../types/SiteArea';
import Constants from '../../../utils/Constants';
import Cypher from '../../../utils/Cypher';
import Logging from '../../../utils/Logging';
import SmartCharging from '../SmartCharging';
import ChargingStationStorage from '../../../storage/mongodb/ChargingStationStorage';

const MODULE_NAME = 'SapSmartCharging';

export default class SapSmartCharging extends SmartCharging<SapSmartChargingSetting> {
  public constructor(tenantID: string, setting: SapSmartChargingSetting) {
    super(tenantID, setting);
  }

  public async checkConnection() {
    const siteArea = {
      maximumPower: 10000,
      chargingStations: [],
    } as SiteArea;
    try {
      const request = this.buildRequest(siteArea, 0);
      // Call Optimizer
      const response = await Axios.post(this.buildUrl(), request, {
        headers: {
          Accept: 'application/json',
        }
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          action: Action.SMART_CHARGING,
          message: `SAP Smart Charging service responded with status '${response.status}' '${response.statusText}'`,
          module: MODULE_NAME, method: 'checkConnection',
          detailedMessages: { response }
        });
      }
    } catch (error) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        message: `SAP Smart Charging service responded with '${error}'`,
        module: MODULE_NAME, method: 'checkConnection',
        detailedMessages: { error: error.message, stack: error.stack }
      });
    }
  }

  public async buildChargingProfiles(siteArea: SiteArea): Promise<ChargingProfile[]> {
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: Action.SMART_CHARGING,
      message: 'Build Charging Profiles is being called',
      module: MODULE_NAME, method: 'buildChargingProfiles',
      detailedMessages: { siteArea }
    });
    // Optimizer implementation:
    // Get seconds since midnight
    // Moment at midnight
    const mmtMidnight = moment().startOf('day');
    // Difference in seconds
    const currentTimeSeconds = moment().diff(mmtMidnight, 'seconds');
    // Get the Charging Stations of the site area with status charging and preparing
    const chargingStations = await ChargingStationStorage.getChargingStations(this.tenantID,
      { siteAreaIDs: [siteArea.id], connectorStatuses: [
        ChargePointStatus.PREPARING,
        ChargePointStatus.CHARGING,
        ChargePointStatus.SUSPENDED_EV,
        ChargePointStatus.SUSPENDED_EVSE,
        ChargePointStatus.OCCUPIED,
      ] }, Constants.DB_PARAMS_MAX_LIMIT);
    siteArea.chargingStations = chargingStations.result;
    try {
      const request = this.buildRequest(siteArea, currentTimeSeconds);
      // Call Optimizer
      const response = await Axios.post(this.buildUrl(), request, {
        headers: {
          Accept: 'application/json',
        }
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          action: Action.SMART_CHARGING,
          message: `SAP Smart Charging service responded with status '${response.status}' '${response.statusText}'`,
          module: MODULE_NAME, method: 'buildChargingProfiles',
          detailedMessages: { response }
        });
      }
      Logging.logDebug({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        message: 'SAP Smart Charging service has been called',
        module: MODULE_NAME, method: 'buildChargingProfiles',
        detailedMessages: { status: response.status, response: response.data }
      });
      // Build charging profiles from result
      const chargingProfiles = await this.buildChargingProfilesFromOptimizer(response.data, (currentTimeSeconds / 60));
      Logging.logDebug({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        message: 'Charging Profiles have been built',
        module: MODULE_NAME, method: 'buildChargingProfiles',
        detailedMessages: { chargingProfiles }
      });
      return chargingProfiles;
    } catch (error) {
      Logging.logError({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        module: MODULE_NAME, method: 'buildChargingProfiles',
        message: 'Unable to call the SAP Smart Charging service',
        detailedMessages: { error: error.message, stack: error.stack },
      });
    }
  }

  private buildUrl(): string {
    // Build URL
    const url = this.setting.optimizerUrl;
    const user = this.setting.user;
    let password = this.setting.password;
    if (password) {
      password = Cypher.decrypt(password);
    }
    if (!url || !user || !password) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        message: 'SAP Smart Charging service configuration is incorrect',
        module: MODULE_NAME, method: 'getChargingProfiles',
      });
    }
    const requestUrl = url.slice(0, 8) + user + ':' + password + '@' + url.slice(8);
    return requestUrl;
  }

  private buildRequest(siteArea: SiteArea, currentTimeSeconds: number): OptimizerChargingProfilesRequest {
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: Action.SMART_CHARGING,
      message: 'Build SAP Smart Charging request is being called',
      module: MODULE_NAME, method: 'buildRequest',
      detailedMessages: {
        siteAreaName: siteArea.name,
        siteAreaMaximumPower: siteArea.maximumPower,
        chargingStations: siteArea.chargingStations ?
          siteArea.chargingStations.map((chargingStation) => chargingStation.id) : []
      }
    });
    // Instantiate initial arrays for request
    const cars: OptimizerCar[] = [];
    const carAssignments: OptimizerCarAssignment[] = [];
    // Create indices to generate IDs in number format
    let fuseID = 1; // Start at 1 because root fuse will have ID=0
    let connectorIndex = 0; // Connector Index to give IDs of format: number
    if (!siteArea.maximumPower) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        module: MODULE_NAME, method: 'buildRequest',
        message: `Maximum Power property is not set for Site Area '${siteArea.name}'`
      });
    }
    // Create root fuse
    const rootFuse: OptimizerFuse = {
      '@type': 'Fuse',
      id: 0,
      fusePhase1: (siteArea.maximumPower / 230) / 3,
      fusePhase2: (siteArea.maximumPower / 230) / 3,
      fusePhase3: (siteArea.maximumPower / 230) / 3,
      children: [],
    };
    // Charging Stations
    if (!siteArea.chargingStations) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        action: Action.SMART_CHARGING,
        module: MODULE_NAME, method: 'buildRequest',
        message: `No Charging Stations found in Site Area '${siteArea.name}'`
      });
    }
    // Loop through charging stations to get each connector
    for (const chargingStation of siteArea.chargingStations) {
      // Create helper to build fuse tree
      let sumConnectorAmperagePhase1 = 0;
      let sumConnectorAmperagePhase2 = 0;
      let sumConnectorAmperagePhase3 = 0;
      const chargingStationChildren = [];
      // Loop through connectors to generate Cars, charging stations and car assignments for request
      for (const connector of chargingStation.connectors) {
        // Check if connector is charging
        // Build Car
        cars.push(this.buildCar(connectorIndex, chargingStation.id, connector.connectorId, connector.totalConsumption));
        // Build Charging Station
        const chargingStationOptimizer = this.buildChargingStation(connectorIndex, connector);
        chargingStationChildren.push(chargingStationOptimizer);
        // Assign Car to Charging Station
        carAssignments.push(this.buildCarAssignment(connectorIndex));
        // Calculate
        sumConnectorAmperagePhase1 += chargingStationOptimizer.fusePhase1;
        sumConnectorAmperagePhase2 += chargingStationOptimizer.fusePhase2;
        sumConnectorAmperagePhase3 += chargingStationOptimizer.fusePhase3;
        connectorIndex++;
      }
      const chargingStationFuse = this.buildChargingStationFuse(
        fuseID, sumConnectorAmperagePhase1, sumConnectorAmperagePhase2,
        sumConnectorAmperagePhase3, chargingStationChildren);
      fuseID++;
      // Push to fuse tree, if children are not empty
      if (chargingStationFuse.children.length > 0) {
        rootFuse.children.push(chargingStationFuse);
      }
    }
    // Build OptimizerFuse Tree (simple)
    const optimizerFuseTree = {
      rootFuse: rootFuse,
    } as OptimizerFuseTree;
    // Build Event
    const optimizerEvent: OptimizerEvent = {
      eventType: 'Reoptimize',
    };
    // Build State
    const optimizerState: OptimizerState = {
      fuseTree: optimizerFuseTree,
      cars: cars,
      currentTimeSeconds: currentTimeSeconds,
      // Property: maximumSiteLimitKW: siteArea.maximumPower, not useful in this case
      carAssignments: carAssignments,
    };
    // Build request
    const request: OptimizerChargingProfilesRequest = {
      event: optimizerEvent,
      state: optimizerState,
    };
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: Action.SMART_CHARGING,
      message: 'Build SAP Smart Charging request has been called',
      module: MODULE_NAME, method: 'buildRequest',
      detailedMessages: { request }
    });
    return request;
  }

  private buildCar(connectorIndex: number, chargingStationID: string, connectorId: number, totalConsumption: number): OptimizerCar {
    // Build 'Safe' car
    return {
      canLoadPhase1: 1,
      canLoadPhase2: 1,
      canLoadPhase3: 1,
      id: connectorIndex,
      timestampArrival: 0,
      carType: 'BEV',
      maxCapacity: 100 * 1000 / 230, // Not usable on DC chargers?
      minLoadingState: 100 * 1000 / 230 * 0.5,
      startCapacity: totalConsumption / 230,
      minCurrent: 0,
      minCurrentPerPhase: 0,
      maxCurrent: 96,
      maxCurrentPerPhase: 32,
      suspendable: true,
      immediateStart: false,
      canUseVariablePower: true,
      name: `${chargingStationID}~${connectorId}`,
    };
  }

  private buildChargingStation(connectorIndex: number, connector: Connector): OptimizerChargingStation {
    // Build charging station from connector
    const chargingStation: OptimizerChargingStation = {
      '@type': 'ChargingStation',
      id: connectorIndex,
      fusePhase1: connector.amperage,
      fusePhase2: ((connector.numberOfConnectedPhase > 1) ? connector.amperage : 0),
      fusePhase3: ((connector.numberOfConnectedPhase > 1) ? connector.amperage : 0),
    };
    return chargingStation;
  }

  private buildCarAssignment(connectorIndex): OptimizerCarAssignment {
    // Build car assignment
    const carAssignment: OptimizerCarAssignment = {
      carID: connectorIndex,
      chargingStationID: connectorIndex
    };
    return carAssignment;
  }

  private buildChargingStationFuse(fuseID: number, sumConnectorAmperagePhase1: number,
    sumConnectorAmperagePhase2: number, sumConnectorAmperagePhase3: number,
    chargingStationChildren: OptimizerChargingStation[]): OptimizerFuse {
    // Each charging station can have multiple connectors (= charge points)
    // A charging station in the optimizer is modelled as a 'fuse'
    // A charging station's connectors are modelled as its 'children'
    const chargingStationFuse: OptimizerFuse = {
      '@type': 'Fuse',
      id: fuseID,
      fusePhase1: sumConnectorAmperagePhase1,
      fusePhase2: sumConnectorAmperagePhase2,
      fusePhase3: sumConnectorAmperagePhase3,
      children: chargingStationChildren,
    };
    return chargingStationFuse;
  }

  private async buildChargingProfilesFromOptimizer(optimizerResult: OptimizerResult, currentTimeMinutes: number): Promise<ChargingProfile[]> {
    const chargingProfiles: ChargingProfile[] = [];
    // Get the last full 15 minutes to set begin of charging profile
    const startSchedule = new Date();
    startSchedule.setUTCMilliseconds(0);
    startSchedule.setSeconds(0);
    startSchedule.setMinutes((Math.floor(startSchedule.getMinutes() / 15)) * 15);
    // Loop through result of optimizer to get each schedule for each car (connector)
    for (const car of optimizerResult.cars) {
      let currentTimeSlot = 0;
      const chargingSchedule = {} as ChargingSchedule;
      chargingSchedule.chargingRateUnit = ChargingRateUnitType.AMPERE;
      chargingSchedule.chargingSchedulePeriod = [];
      chargingSchedule.startSchedule = startSchedule;
      for (let i = Math.floor(currentTimeMinutes / 15); i < Math.floor(currentTimeMinutes / 15) + 3; i++) {
        chargingSchedule.chargingSchedulePeriod.push({
          startPeriod: currentTimeSlot * 15 * 60,
          limit: Math.trunc(car.currentPlan[i] * 3)
        });
        currentTimeSlot++;
      }
      // Set duration
      chargingSchedule.duration = currentTimeSlot * 15 * 60;
      // Get ChargingStation ID and Connector ID from name property
      const chargingStationDetails = car.name.split('~');
      const chargingStationID = chargingStationDetails[0];
      // Get the charging station
      const chargingStation = await ChargingStationStorage.getChargingStation(this.tenantID, chargingStationID);
      if (!chargingStation) {
        throw new BackendError({
          source: chargingStationID,
          action: Action.SMART_CHARGING,
          module: MODULE_NAME, method: 'buildChargingProfilesFromOptimizer',
          message: 'Charging Station not found'
        });
      }
      const connectorId = parseInt(chargingStationDetails[1]);
      const connector = chargingStation.connectors[connectorId - 1];
      // Build profile of charging profile
      const profile: Profile = {
        chargingProfileId: connectorId,
        chargingProfileKind: ChargingProfileKindType.ABSOLUTE,
        chargingProfilePurpose: ChargingProfilePurposeType.TX_PROFILE,
        transactionId: connector.activeTransactionID,
        stackLevel: 2,
        chargingSchedule: chargingSchedule
      };
      // Build charging profile with charging station id and connector id
      const chargingProfile: ChargingProfile = {
        chargingStationID: chargingStationID,
        connectorID: connectorId,
        profile: profile
      };
      // Resolve id for charging station and connector from helper array
      chargingProfiles.push(chargingProfile);
    }
    return chargingProfiles;
  }
}
