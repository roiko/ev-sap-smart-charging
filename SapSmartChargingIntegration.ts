import { AxiosInstance, AxiosResponse } from 'axios';
import moment from 'moment';
import BackendError from '../../../exception/BackendError';
import ChargingStationStorage from '../../../storage/mongodb/ChargingStationStorage';
import TransactionStorage from '../../../storage/mongodb/TransactionStorage';
import { ChargingProfile, ChargingProfileKindType, ChargingProfilePurposeType, ChargingRateUnitType, ChargingSchedule, Profile } from '../../../types/ChargingProfile';
import ChargingStation, { ChargePoint, Connector, StaticLimitAmps } from '../../../types/ChargingStation';
import { ChargePointStatus } from '../../../types/ocpp/OCPPServer';
import { ConnectorPower, OptimizerCar, OptimizerCarConnectorAssignment, OptimizerChargingProfilesRequest, OptimizerChargingStationConnectorFuse, OptimizerChargingStationFuse, OptimizerFuse, OptimizerResult } from '../../../types/Optimizer';
import { ServerAction } from '../../../types/Server';
import { SapSmartChargingSetting } from '../../../types/Setting';
import SiteArea from '../../../types/SiteArea';
import Transaction from '../../../types/Transaction';
import AxiosFactory from '../../../utils/AxiosFactory';
import Constants from '../../../utils/Constants';
import Cypher from '../../../utils/Cypher';
import Logging from '../../../utils/Logging';
import Utils from '../../../utils/Utils';
import SmartChargingIntegration from '../SmartChargingIntegration';


const MODULE_NAME = 'SapSmartChargingIntegration';

export default class SapSmartChargingIntegration extends SmartChargingIntegration<SapSmartChargingSetting> {
  private axiosInstance: AxiosInstance;

  public constructor(tenantID: string, setting: SapSmartChargingSetting) {
    super(tenantID, setting);
    this.axiosInstance = AxiosFactory.getAxiosInstance();
  }

  public async checkConnection(): Promise<void> {
    const siteArea = {
      name: 'Dummy Site Area',
      maximumPower: 10000,
      chargingStations: [],
      numberOfPhases: 3,
      voltage: 230
    } as SiteArea;
    try {
      // Build Optimizer request
      const request = await this.buildOptimizerRequest(siteArea, 0);
      // Call Optimizer
      let response: AxiosResponse;
      const optimizerURL = this.buildOptimizerUrl(siteArea);
      try {
        response = await this.axiosInstance.post(optimizerURL, request, {
          headers: {
            Accept: 'application/json',
          }
        });
      } catch (error) {
        // Handle errors
        Utils.handleAxiosError(error, optimizerURL, ServerAction.SMART_CHARGING, MODULE_NAME, 'checkConnection');
      }
    } catch (error) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.SMART_CHARGING,
        message: `${siteArea.name} > SAP Smart Charging service responded with '${error}'`,
        module: MODULE_NAME, method: 'checkConnection',
        detailedMessages: { error: error.message, stack: error.stack }
      });
    }
  }

  public async buildChargingProfiles(siteArea: SiteArea): Promise<ChargingProfile[]> {
    // Get seconds since midnight
    const currentDurationFromMidnightSeconds = moment().diff(moment().startOf('day'), 'seconds');
    // Get the Charging Stations of the site area with status charging and preparing
    const chargingStations = await ChargingStationStorage.getChargingStations(this.tenantID,
      { siteAreaIDs: [siteArea.id], connectorStatuses: [ChargePointStatus.CHARGING, ChargePointStatus.SUSPENDED_EVSE] },
      Constants.DB_PARAMS_MAX_LIMIT);
    siteArea.chargingStations = chargingStations.result;
    const request = await this.buildOptimizerRequest(siteArea, currentDurationFromMidnightSeconds);
    // Call optimizer
    const url = this.buildOptimizerUrl(siteArea);
    // Check at least one car
    if (request.state.cars.length === 0) {
      Logging.logDebug({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.SMART_CHARGING,
        message: `${siteArea.name} > No car connected so no need to call the SAP Smart Charging service`,
        module: MODULE_NAME, method: 'buildChargingProfiles',
        detailedMessages: { request }
      });
      return;
    }
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: ServerAction.SMART_CHARGING,
      message: `${siteArea.name} > Call the SAP Smart Charging service...`,
      module: MODULE_NAME, method: 'buildChargingProfiles',
      detailedMessages: { url, request }
    });
    let response: AxiosResponse;
    try {
      // Call Optimizer
      response = await this.axiosInstance.post(url, request, {
        headers: {
          Accept: 'application/json',
        }
      });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, url, ServerAction.SMART_CHARGING, MODULE_NAME, 'buildChargingProfiles');
    }
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: ServerAction.SMART_CHARGING,
      message: `${siteArea.name} > SAP Smart Charging service has been called successfully`,
      module: MODULE_NAME, method: 'buildChargingProfiles',
      detailedMessages: { response: response.data }
    });
    // Build charging profiles from result
    const chargingProfiles = await this.buildChargingProfilesFromOptimizerResponse(
      siteArea, response.data, currentDurationFromMidnightSeconds / 60);
    Logging.logDebug({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: ServerAction.SMART_CHARGING,
      message: `${siteArea.name} > Charging Profiles have been built successfully`,
      module: MODULE_NAME, method: 'buildChargingProfiles',
      detailedMessages: { chargingProfiles }
    });
    return chargingProfiles;
  }

  private buildOptimizerUrl(siteArea: SiteArea): string {
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
        action: ServerAction.SMART_CHARGING,
        message: `${siteArea.name} > SAP Smart Charging service configuration is incorrect`,
        module: MODULE_NAME, method: 'getChargingProfiles',
      });
    }
    const requestUrl = url.slice(0, 8) + user + ':' + password + '@' + url.slice(8);
    return requestUrl;
  }

  private async buildOptimizerRequest(siteArea: SiteArea, currentTimeSeconds: number): Promise<OptimizerChargingProfilesRequest> {
    // Instantiate initial arrays for request
    const cars: OptimizerCar[] = [];
    const carConnectorAssignments: OptimizerCarConnectorAssignment[] = [];
    // Create indices to generate IDs in number format
    let fuseID = 0;
    this.checkIfSiteAreaIsValid(siteArea);
    // Adjust site limitation
    this.adjustSiteLimitation(siteArea);
    // Create root fuse
    const siteMaxAmps = siteArea.maximumPower / siteArea.voltage;
    const siteMaxAmpsPerPhase = siteMaxAmps / siteArea.numberOfPhases;
    const rootFuse: OptimizerFuse = {
      '@type': 'Fuse',
      id: fuseID++,
      fusePhase1: siteMaxAmpsPerPhase,
      fusePhase2: siteArea.numberOfPhases > 1 ? siteMaxAmpsPerPhase : 0,
      fusePhase3: siteArea.numberOfPhases > 1 ? siteMaxAmpsPerPhase : 0,
      phase1Connected: true,
      phase2Connected: siteArea.numberOfPhases > 1 ? true : false,
      phase3Connected: siteArea.numberOfPhases > 1 ? true : false,
      children: [],
    };
    // Loop through charging stations to get each connector
    for (const chargingStation of siteArea.chargingStations) {
      // Create helper to build fuse tree
      let sumConnectorAmperagePhase1 = 0;
      let sumConnectorAmperagePhase2 = 0;
      let sumConnectorAmperagePhase3 = 0;
      const chargingStationConnectorsFuse: OptimizerChargingStationConnectorFuse[] = [];
      // Loop through connectors to generate Cars, charging stations and car assignments for request
      for (const connector of chargingStation.connectors) {
        // Get the transaction
        const transaction = await this.getTransactionFromChargingConnector(siteArea, chargingStation, connector);
        // Build connector fuse
        const chargingStationConnectorFuse = this.buildChargingStationConnectorFuse(siteArea, fuseID, chargingStation, connector);
        if (!chargingStationConnectorFuse) {
          continue;
        }
        chargingStationConnectorsFuse.push(chargingStationConnectorFuse);
        // Add connector's power
        sumConnectorAmperagePhase1 += chargingStationConnectorFuse.fusePhase1;
        sumConnectorAmperagePhase2 += chargingStationConnectorFuse.fusePhase2;
        sumConnectorAmperagePhase3 += chargingStationConnectorFuse.fusePhase3;
        // Build car
        const car = this.buildCar(fuseID, chargingStation, transaction);
        cars.push(car);
        // Assign car to the connector
        carConnectorAssignments.push({
          carID: fuseID,
          chargingStationID: fuseID // It's a connector but for the optimizer this is a Charging Station
        });
        fuseID++;
      } // End for of connectors
      // Build Charging Station fuse
      const chargingStationFuse = this.buildChargingStationFuse(
        fuseID, sumConnectorAmperagePhase1, sumConnectorAmperagePhase2, sumConnectorAmperagePhase3,
        chargingStationConnectorsFuse);
      fuseID++;
      // Push to fuse tree, if children are not empty
      if (chargingStationFuse.children.length > 0) {
        rootFuse.children.push(chargingStationFuse);
      }
    } // End for of charging stations
    // Build request
    const request: OptimizerChargingProfilesRequest = {
      event: {
        eventType: 'Reoptimize',
      },
      state: {
        fuseTree: {
          rootFuse: rootFuse,
        },
        cars: cars,
        carAssignments: carConnectorAssignments,
        currentTimeSeconds: currentTimeSeconds,
      },
    };
    return request;
  }

  private async getTransactionFromChargingConnector(siteArea: SiteArea, chargingStation: ChargingStation, connector: Connector): Promise<Transaction> {
    // Transaction in progress?
    if (!connector.currentTransactionID) {
      // Should not happen
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getTransactionFromChargingConnector',
        message: `${siteArea.name} > No active transaction on connector ID '${connector.connectorId}'`,
        detailedMessages: { connector, chargingStation }
      });
    }
    // Get the transaction
    const transaction = await TransactionStorage.getTransaction(this.tenantID, connector.currentTransactionID);
    if (!transaction) {
      // Should not happen
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getTransactionFromChargingConnector',
        message: `${siteArea.name} > Active transaction ID '${connector.currentTransactionID}' on connector ID '${connector.connectorId}' not found!`,
        detailedMessages: { connector, chargingStation }
      });
    }
    return transaction;
  }

  private adjustSiteLimitation(siteArea: SiteArea) {
    const originalSiteMaxAmps = siteArea.maximumPower / siteArea.voltage;
    let siteMaxAmps = siteArea.maximumPower / siteArea.voltage;
    for (let i = siteArea.chargingStations.length - 1; i >= 0; i--) {
      const chargingStation = siteArea.chargingStations[i];
      const chargePointIDsAlreadyProcessed = [];
      const chargingStationVoltage = Utils.getChargingStationVoltage(chargingStation);
      // Handle charging station that does not support smart charging
      if (chargingStation.excludeFromSmartCharging) {
        // Remove charging station
        siteArea.chargingStations.splice(i, 1);
        // Remove the power of the whole charging station
        siteMaxAmps -= (chargingStation.maximumPower / chargingStationVoltage);
      // Handle charge point does not support smart charging
      } else {
        // Only connectors which charge are in this list
        for (let j = chargingStation.connectors.length - 1; j >= 0; j--) {
          const connector = chargingStation.connectors[j];
          if (connector.chargePointID) {
            const chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
            if (chargePoint.excludeFromPowerLimitation &&
               !chargePointIDsAlreadyProcessed.includes(chargePoint.chargePointID)) {
              // Remove the power of the connector
              const connectorAmperage = Utils.getChargingStationAmperage(chargingStation, chargePoint);
              siteMaxAmps -= connectorAmperage;
              // Remove the connector
              chargingStation.connectors.splice(j, 1);
              // Do not process the same charge point
              chargePointIDsAlreadyProcessed.push(chargePoint.chargePointID);
            }
          }
        }
        // Check if there are remaining connectors
        if (chargingStation.connectors.length === 0) {
          // Remove charging station
          siteArea.chargingStations.splice(i, 1);
        }
      }
    }
    // Ensure always positive
    if (siteMaxAmps < 0) {
      siteMaxAmps = 0;
    }
    // Found unsupported chargers
    if (siteMaxAmps !== originalSiteMaxAmps) {
      Logging.logDebug({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.SMART_CHARGING,
        message: `${siteArea.name} > limit of ${siteArea.maximumPower} W has been lowered to ${Math.round(siteMaxAmps * siteArea.voltage)} W due to unsupported charging stations currently being used`,
        module: MODULE_NAME, method: 'adjustSiteLimitation',
        detailedMessages: { siteArea }
      });
      // Limit Site Area power
      siteArea.maximumPower = siteMaxAmps * siteArea.voltage;
    }
  }

  private buildCar(fuseID: number, chargingStation: ChargingStation, transaction: Transaction): OptimizerCar {
    const voltage = Utils.getChargingStationVoltage(chargingStation);
    const numberOfPhases = Utils.getNumberOfConnectedPhases(chargingStation, null, transaction.connectorId);
    const maxConnectorAmps = Utils.getChargingStationAmperage(chargingStation, null, transaction.connectorId);
    // Handle the SoC if provided (only DC chargers)
    let currentSoc = 0.5;
    if (transaction.currentStateOfCharge) {
      currentSoc = transaction.currentStateOfCharge / 100;
    }
    // Auto detect the number of phases of the car
    const threePhasesCar = Utils.isTransactionInProgressOnThreePhases(chargingStation, transaction);
    // Build a 'Safe' car
    const car: OptimizerCar = {
      canLoadPhase1: 1, // 3 phases car
      canLoadPhase2: numberOfPhases === 1 ? 0 : (threePhasesCar ? 1 : 0),
      canLoadPhase3: numberOfPhases === 1 ? 0 : (threePhasesCar ? 1 : 0),
      id: fuseID,
      timestampArrival: moment(transaction.timestamp).diff(moment().startOf('day'), 'seconds'), // Arrival timestamp in seconds from midnight
      timestampDeparture: 62100, // Mock timestamp departure (17:15) - recommendation from Oliver
      carType: 'BEV',
      maxCapacity: 100 * 1000 / voltage, // Battery capacity in Amp.h (fixed to 100kW.h)
      minLoadingState: (100 * 1000 / voltage) * currentSoc, // Current battery level in Amp.h set at 50% (fixed to 50kW.h)
      startCapacity: transaction.currentTotalConsumptionWh / voltage, // Total consumption in Amp.h
      minCurrent: threePhasesCar ? (StaticLimitAmps.MIN_LIMIT_PER_PHASE * numberOfPhases) : StaticLimitAmps.MIN_LIMIT_PER_PHASE,
      minCurrentPerPhase: StaticLimitAmps.MIN_LIMIT_PER_PHASE,
      maxCurrent: threePhasesCar ? maxConnectorAmps : (maxConnectorAmps / numberOfPhases), // Charge capability in Amps
      maxCurrentPerPhase: maxConnectorAmps / numberOfPhases, // Charge capability in Amps per phase
      suspendable: true,
      immediateStart: false,
      canUseVariablePower: true,
      name: `${transaction.chargeBoxID}~${transaction.connectorId}`,
    };
    return car;
  }

  private connectorIsCharging(connector: Connector): boolean {
    return connector.status === ChargePointStatus.CHARGING ||
      connector.status === ChargePointStatus.SUSPENDED_EV ||
      connector.status === ChargePointStatus.SUSPENDED_EVSE ||
      connector.status === ChargePointStatus.OCCUPIED;
  }

  private getConnectorNbrOfPhasesAndAmps(siteArea: SiteArea, chargingStation: ChargingStation, connector: Connector): ConnectorPower {
    const connectorPower: ConnectorPower = {
      numberOfConnectedPhase: 0,
      totalAmps: 0
    };
    if (connector.chargePointID) {
      const chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
      // Get the usual power
      connectorPower.numberOfConnectedPhase = Utils.getNumberOfConnectedPhases(chargingStation, chargePoint, connector.connectorId);
      connectorPower.totalAmps = Utils.getChargingStationAmperage(chargingStation, chargePoint, connector.connectorId);
      // Check if the charging station share the power on all connectors and distribute the power evenly
      // Check also if the charging station can charge in // and all other connectors are free
      if (chargePoint.sharePowerToAllConnectors || chargePoint.cannotChargeInParallel) {
        // Get the number of connector in activity
        let numberOfConnectorsCurrentlyCharging = 0;
        for (const connectorID of chargePoint.connectorIDs) {
          const connectorOfChargePoint = Utils.getConnectorFromID(chargingStation, connectorID);
          // Double Check: Normally only connector charging are in the charging station object
          if (!connectorOfChargePoint) {
            continue;
          }
          if (this.connectorIsCharging(connectorOfChargePoint)) {
            numberOfConnectorsCurrentlyCharging++;
          }
        }
        // Should be at least 1
        if (numberOfConnectorsCurrentlyCharging >= 1) {
          // Already several connectors to share energy with
          if (chargePoint.sharePowerToAllConnectors) {
            connectorPower.totalAmps /= numberOfConnectorsCurrentlyCharging;
          }
          // Already several connectors charging in //
          if (chargePoint.cannotChargeInParallel && numberOfConnectorsCurrentlyCharging > 1) {
            // Annihilate the power of the connector
            connectorPower.totalAmps = 0;
          }
        }
      }
    } else {
      connectorPower.numberOfConnectedPhase = connector.numberOfConnectedPhase;
      connectorPower.totalAmps = connector.amperage;
    }
    if (!connectorPower.numberOfConnectedPhase) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getConnectorNbrOfPhasesAndAmps',
        message: `${siteArea.name} > Cannot get the number of phases of connector ID '${connector.connectorId}'`,
        detailedMessages: { connector, chargingStation }
      });
    }
    if (!connectorPower.totalAmps) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getConnectorNbrOfPhasesAndAmps',
        message: `${siteArea.name} > Cannot get the amperage of connector ID '${connector.connectorId}'`,
        detailedMessages: { connector, chargingStation }
      });
    }
    return connectorPower;
  }

  private buildChargingStationConnectorFuse(siteArea: SiteArea, fuseID: number, chargingStation: ChargingStation, connector: Connector): OptimizerChargingStationConnectorFuse {
    // Get connector's power
    const connectorPower = this.getConnectorNbrOfPhasesAndAmps(siteArea, chargingStation, connector);
    const connectorAmpsPerPhase = connectorPower.totalAmps / connectorPower.numberOfConnectedPhase;
    // Build charging station from connector
    const chargingStationConnectorFuse: OptimizerChargingStationConnectorFuse = {
      '@type': 'ChargingStation', // It's connector but for the optimizer this is a Charging Station
      id: fuseID,
      fusePhase1: connectorAmpsPerPhase,
      fusePhase2: (connectorPower.numberOfConnectedPhase > 1 ? connectorAmpsPerPhase : 0),
      fusePhase3: (connectorPower.numberOfConnectedPhase > 1 ? connectorAmpsPerPhase : 0),
      phase1Connected: true,
      phase2Connected: (connectorPower.numberOfConnectedPhase > 1 ? true : false),
      phase3Connected: (connectorPower.numberOfConnectedPhase > 1 ? true : false),
    };
    return chargingStationConnectorFuse;
  }

  private buildChargingStationFuse(fuseID: number,
    sumConnectorAmperagePhase1: number, sumConnectorAmperagePhase2: number, sumConnectorAmperagePhase3: number,
    chargingStationConnectorsFuse: OptimizerChargingStationConnectorFuse[]): OptimizerChargingStationFuse {
    // Each charging station can have multiple connectors (= charge points)
    // A charging station in the optimizer is modelled as a 'fuse'
    // A charging station's connectors are modelled as its 'children'
    const chargingStationFuse: OptimizerChargingStationFuse = {
      '@type': 'Fuse',
      id: fuseID,
      fusePhase1: sumConnectorAmperagePhase1,
      fusePhase2: sumConnectorAmperagePhase2,
      fusePhase3: sumConnectorAmperagePhase3,
      phase1Connected: true,
      phase2Connected: (sumConnectorAmperagePhase2 > 0 ? true : false),
      phase3Connected: (sumConnectorAmperagePhase3 > 0 ? true : false),
      children: chargingStationConnectorsFuse,
    };
    return chargingStationFuse;
  }

  private async buildChargingProfilesFromOptimizerResponse(siteArea: SiteArea, optimizerResult: OptimizerResult, currentDurationFromMidnightMins: number): Promise<ChargingProfile[]> {
    const chargingProfiles: ChargingProfile[] = [];
    // Get the last full 15 minutes to set begin of charging profile
    const startSchedule = new Date();
    startSchedule.setUTCMilliseconds(0);
    startSchedule.setSeconds(0);
    startSchedule.setMinutes((Math.floor(startSchedule.getMinutes() / 15)) * 15);
    // Loop through result of optimizer to get each schedule for each car (connector)
    for (const car of optimizerResult.cars) {
      let currentTimeSlotMins = 0;
      const chargingSchedule = {} as ChargingSchedule;
      // Get ChargingStation ID and Connector ID from name property
      const chargingStationDetails = car.name.split('~');
      const chargingStationID = chargingStationDetails[0];
      const connectorID = Utils.convertToInt(chargingStationDetails[1]);
      // Get the charging station
      const chargingStation = await ChargingStationStorage.getChargingStation(this.tenantID, chargingStationID);
      if (!chargingStation) {
        throw new BackendError({
          source: chargingStationID,
          action: ServerAction.SMART_CHARGING,
          module: MODULE_NAME, method: 'buildChargingProfilesFromOptimizerResponse',
          message: `${siteArea.name} > Charging Station not found`
        });
      }
      const connector = Utils.getConnectorFromID(chargingStation, connectorID);
      let numberOfConnectedPhase = 0;
      let chargePoint: ChargePoint;
      if (connector.chargePointID) {
        chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
        numberOfConnectedPhase = Utils.getNumberOfConnectedPhases(chargingStation, chargePoint, connector.connectorId);
      } else {
        numberOfConnectedPhase = connector.numberOfConnectedPhase;
      }
      // Set profile
      chargingSchedule.chargingRateUnit = ChargingRateUnitType.AMPERE;
      chargingSchedule.chargingSchedulePeriod = [];
      chargingSchedule.startSchedule = startSchedule;
      // Start from now up to the third slot
      for (let i = Math.floor(currentDurationFromMidnightMins / 15); i < car.currentPlan.length && (car.currentPlan[i] > 0 || chargingSchedule.chargingSchedulePeriod.length < 3); i++) {
        chargingSchedule.chargingSchedulePeriod.push({
          startPeriod: currentTimeSlotMins * 15 * 60, // Start period in secs (starts at 0 sec from startSchedule date/time)
          limit: Math.trunc(car.currentPlan[i] * numberOfConnectedPhase)
        });
        currentTimeSlotMins++;
      }
      // Set total duration in secs
      chargingSchedule.duration = currentTimeSlotMins * 15 * 60;
      // Build profile of charging profile
      const profile: Profile = {
        chargingProfileId: connectorID,
        chargingProfileKind: ChargingProfileKindType.ABSOLUTE,
        chargingProfilePurpose: ChargingProfilePurposeType.TX_PROFILE, // Profile with constraints to be imposed by the Charge Point on the current transaction. A profile with this purpose SHALL cease to be valid when the transaction terminates.
        transactionId: connector.currentTransactionID,
        stackLevel: 2, // Value determining level in hierarchy stack of profiles. Higher values have precedence over lower values. Lowest level is 0.
        chargingSchedule: chargingSchedule
      };
      // Build charging profile with charging station id and connector id
      const chargingProfile: ChargingProfile = {
        chargingStationID: chargingStationID,
        connectorID: connectorID,
        chargePointID: chargePoint.chargePointID,
        profile: profile
      };
      // Resolve id for charging station and connector from helper array
      chargingProfiles.push(chargingProfile);
    } // End for of cars
    return chargingProfiles;
  }
}
