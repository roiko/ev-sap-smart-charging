import { ChargingProfile, ChargingProfileKindType, ChargingProfilePurposeType, ChargingRateUnitType, ChargingSchedule, Profile } from '../../../types/ChargingProfile';
import ChargingStation, { ChargePoint, Connector, CurrentType, StaticLimitAmps } from '../../../types/ChargingStation';
import { ConnectorAmps, OptimizerCar, OptimizerCarConnectorAssignment, OptimizerChargingProfilesRequest, OptimizerChargingStationConnectorFuse, OptimizerChargingStationFuse, OptimizerFuse, OptimizerResult } from '../../../types/Optimizer';

import AxiosFactory from '../../../utils/AxiosFactory';
import { AxiosInstance } from 'axios';
import BackendError from '../../../exception/BackendError';
import { Car } from '../../../types/Car';
import CarStorage from '../../../storage/mongodb/CarStorage';
import { ChargePointStatus } from '../../../types/ocpp/OCPPServer';
import ChargingStationStorage from '../../../storage/mongodb/ChargingStationStorage';
import Constants from '../../../utils/Constants';
import Cypher from '../../../utils/Cypher';
import Logging from '../../../utils/Logging';
import { SapSmartChargingSetting } from '../../../types/Setting';
import { ServerAction } from '../../../types/Server';
import SiteArea from '../../../types/SiteArea';
import SmartChargingIntegration from '../SmartChargingIntegration';
import Transaction from '../../../types/Transaction';
import TransactionStorage from '../../../storage/mongodb/TransactionStorage';
import Utils from '../../../utils/Utils';
import moment from 'moment';

const MODULE_NAME = 'SapSmartChargingIntegration';

export default class SapSmartChargingIntegration extends SmartChargingIntegration<SapSmartChargingSetting> {
  private axiosInstance: AxiosInstance;
  private currentChargingProfiles: ChargingProfile[];

  public constructor(tenantID: string, setting: SapSmartChargingSetting) {
    super(tenantID, setting);
    this.axiosInstance = AxiosFactory.getAxiosInstance(this.tenantID);
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
      const optimizerURL = this.buildOptimizerUrl(siteArea);
      await this.axiosInstance.post(optimizerURL, request, {
        headers: {
          Accept: 'application/json',
        }
      });
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

  public async buildChargingProfiles(siteArea: SiteArea, excludedChargingStations?: string[]): Promise<ChargingProfile[]> {
    // Get seconds since midnight
    const currentDurationFromMidnightSeconds = moment().diff(moment().startOf('day'), 'seconds');
    // Get the Charging Stations of the site area with status charging and preparing
    const chargingStations = await ChargingStationStorage.getChargingStations(this.tenantID,
      { siteAreaIDs: [siteArea.id], connectorStatuses: [ChargePointStatus.CHARGING, ChargePointStatus.SUSPENDED_EVSE] },
      Constants.DB_PARAMS_MAX_LIMIT);
    siteArea.chargingStations = chargingStations.result;
    const request = await this.buildOptimizerRequest(siteArea, currentDurationFromMidnightSeconds, excludedChargingStations);
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
    // Call Optimizer
    const response = await this.axiosInstance.post(url, request, {
      headers: {
        Accept: 'application/json',
      }
    });
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

  private async buildOptimizerRequest(siteArea: SiteArea, currentTimeSeconds: number, excludedChargingStations?: string[]): Promise<OptimizerChargingProfilesRequest> {
    // Get and set current profiles if sticky limitation is enabled
    if (this.setting.stickyLimitation) {
      // Get all the charging station IDs from the site area
      const chargingStationIDs = [];
      for (const chargingStation of siteArea.chargingStations) {
        chargingStationIDs.push(chargingStation.id);
      }
      // Get all Profiles from the site area
      const currentChargingProfilesResponse = await ChargingStationStorage.getChargingProfiles(
        this.tenantID, { chargingStationIDs: chargingStationIDs }, Constants.DB_PARAMS_MAX_LIMIT);
      this.currentChargingProfiles = currentChargingProfilesResponse.result;
    }
    // Instantiate initial arrays for request
    const cars: OptimizerCar[] = [];
    const carConnectorAssignments: OptimizerCarConnectorAssignment[] = [];
    // Create indices to generate IDs in number format
    let fuseID = 0;
    this.checkIfSiteAreaIsValid(siteArea);
    // Adjust site limitation
    this.adjustSiteLimitation(siteArea, excludedChargingStations);
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
        let car = {} as OptimizerCar;
        // If Car ID is provided - build custom car
        car = await this.buildCar(fuseID, chargingStation, transaction, currentTimeSeconds);
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

  private adjustSiteLimitation(siteArea: SiteArea, excludedChargingStations?: string[]) {
    const originalSiteMaxAmps = siteArea.maximumPower / siteArea.voltage;
    let siteMaxAmps = siteArea.maximumPower / siteArea.voltage;
    for (let i = siteArea.chargingStations.length - 1; i >= 0; i--) {
      const chargingStation = siteArea.chargingStations[i];
      const chargePointIDsAlreadyProcessed = [];
      const chargingStationVoltage = Utils.getChargingStationVoltage(chargingStation);
      // Handle charging station that does not support smart charging
      if (chargingStation.excludeFromSmartCharging || excludedChargingStations?.includes(chargingStation.id)) {
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
              const connectorAmperage = Utils.getChargingStationAmperage(chargingStation, chargePoint, connector.connectorId);
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

  private buildSafeCar(fuseID: number, chargingStation: ChargingStation, transaction: Transaction, currentTimeSeconds: number): OptimizerCar {
    const voltage = Utils.getChargingStationVoltage(chargingStation);
    const maxConnectorAmpsPerPhase = Utils.getChargingStationAmperagePerPhase(chargingStation, null, transaction.connectorId);
    const timestampArrivalInSeconds = moment(transaction.timestamp).diff(moment().startOf('day'), 'seconds');
    // Build a 'Safe' car
    const car: OptimizerCar = {
      canLoadPhase1: 1,
      canLoadPhase2: 1,
      canLoadPhase3: 1,
      id: fuseID,
      // Arrival timestamp in seconds from midnight
      timestampArrival: currentTimeSeconds > timestampArrivalInSeconds ? timestampArrivalInSeconds : // Check if timestamp arrival is in the past
        ((currentTimeSeconds + 30) > timestampArrivalInSeconds ? currentTimeSeconds : 0), // Check if charging station is before current time or if it is arrival of the previous day
      // TimestampDeparture is not useful for the time being, because if hard coded it lets the request fail after 17:15, can be taken in again, when the user is able to enter a departure time (with a check if it is after the current time)
      // timestampDeparture: 62100, // Mock timestamp departure (17:15) - recommendation from Oliver
      carType: 'BEV',
      maxCapacity: 100 * 1000 / voltage, // Battery capacity in Amp.h (fixed to 100kW.h)
      minLoadingState: (100 * 1000 / voltage) * 0.5, // Battery level at the end of the charge in Amp.h set at 50% (fixed to 50kW.h)
      startCapacity: transaction.currentTotalConsumptionWh / voltage, // Total consumption in Amp.h
      minCurrent: StaticLimitAmps.MIN_LIMIT_PER_PHASE * 3,
      minCurrentPerPhase: StaticLimitAmps.MIN_LIMIT_PER_PHASE,
      maxCurrent: maxConnectorAmpsPerPhase * 3, // Charge capability in Amps
      maxCurrentPerPhase: maxConnectorAmpsPerPhase, // Charge capability in Amps per phase
      suspendable: true,
      immediateStart: false,
      canUseVariablePower: true,
      name: `${transaction.chargeBoxID}~${transaction.connectorId}`,
    };
    return car;
  }

  private async buildCar(fuseID: number, chargingStation: ChargingStation, transaction: Transaction, currentTimeSeconds: number): Promise<OptimizerCar> {
    const voltage = Utils.getChargingStationVoltage(chargingStation);
    const customCar = this.buildSafeCar(fuseID, chargingStation, transaction, currentTimeSeconds);
    // Handle provided Car
    if (transaction.carID) {
      const transactionCar: Car = await CarStorage.getCar(this.tenantID, transaction.carID);
      // Setting limit from car only for 3 phased stations (AmpPerPhase-capability variates on single phased charging)
      if (Utils.getChargingStationCurrentType(chargingStation, null, transaction.connectorId) === CurrentType.AC &&
        Utils.getNumberOfConnectedPhases(chargingStation, null, transaction.connectorId) === 3) {
        if (transactionCar?.converter?.amperagePerPhase > 0) {
          customCar.maxCurrentPerPhase = transactionCar.converter.amperagePerPhase; // Charge capability in Amps per phase
          customCar.maxCurrent = transactionCar.converter.amperagePerPhase * 3; // Charge capability in Amps
        }
      } else if (Utils.getChargingStationCurrentType(chargingStation, null, transaction.connectorId) === CurrentType.DC) {
        if (transactionCar?.carCatalog?.fastChargePowerMax > 0) {
          const maxDCCurrent = Utils.convertWattToAmp(
            chargingStation, null, transaction.connectorId, transactionCar.carCatalog.fastChargePowerMax * 1000); // Charge capability in Amps
          customCar.maxCurrentPerPhase = Utils.roundTo((maxDCCurrent / 3), 3); // Charge capability in Amps per phase
          customCar.maxCurrent = customCar.maxCurrentPerPhase * 3;
        }
      }
      if (transactionCar?.carCatalog?.batteryCapacityFull > 0) {
        customCar.maxCapacity = transactionCar.carCatalog.batteryCapacityFull * 1000 / voltage; // Battery capacity in Amp.h
        customCar.minLoadingState = (transactionCar.carCatalog.batteryCapacityFull * 1000 / voltage) * 0.5; // Battery level at the end of the charge in Amp.h set at 50%
      }
    }
    // Override
    this.overrideCarWithRuntimeData(chargingStation, transaction, customCar);
    // Check if CS is DC and calculate real consumption at the grid
    if (Utils.getChargingStationCurrentType(chargingStation, null, transaction.connectorId) === CurrentType.DC) {
      const connector = Utils.getConnectorFromID(chargingStation, transaction.connectorId);
      const chargePoint = Utils.getChargePointFromID(chargingStation, connector?.chargePointID);
      if (chargePoint?.efficiency > 0) {
        customCar.maxCurrentPerPhase /= chargePoint.efficiency / 100;
        customCar.maxCurrent = customCar.maxCurrentPerPhase * 3;
      } else {
        // Use safe value if efficiency is not provided
        customCar.maxCurrentPerPhase /= Constants.DC_CHARGING_STATION_DEFAULT_EFFICIENCY_PERCENT / 100;
        customCar.maxCurrent = customCar.maxCurrentPerPhase * 3;
      }
    }
    return customCar;
  }

  private overrideCarWithRuntimeData(chargingStation: ChargingStation, transaction: Transaction, car: OptimizerCar) {
    // Check if meter value already received with phases used (only on AC stations)
    if (transaction.phasesUsed) {
      const numberOfPhasesInProgress = Utils.getNumberOfUsedPhasesInTransactionInProgress(chargingStation, transaction);
      // Check if Phases Valid
      if (numberOfPhasesInProgress !== -1) {
        // Check if sticky limit enabled
        if (this.setting.stickyLimitation) {
          // Check if car wants to increase its consumption --> if yes do not limit according the current consumption
          const carIsIncreasingConsumption = this.checkIfCarIsIncreasingConsumption(
            chargingStation, transaction, CurrentType.AC, car, numberOfPhasesInProgress);
          if (!carIsIncreasingConsumption) {
            // Check if Car is consuming energy --> if yes do not limit according the current consumption
            if (transaction.currentInstantAmps > 0) {
            // Setting limit to the current instant amps with buffer (If it goes above the station limit it will be limited by the optimizer fuse tree)
              car.maxCurrentPerPhase = Utils.roundTo((transaction.currentInstantAmps / numberOfPhasesInProgress *
              (1 + (typeof this.setting.limitBufferAC === 'number' ? this.setting.limitBufferAC : 0) / 100)), 3);
            } else {
            // When car is not consuming energy limit is set to min Amps
              car.maxCurrentPerPhase = car.minCurrentPerPhase;
            }
          }
        }
        car.canLoadPhase1 = transaction.phasesUsed.csPhase1 ? 1 : 0;
        car.canLoadPhase2 = transaction.phasesUsed.csPhase2 ? 1 : 0;
        car.canLoadPhase3 = transaction.phasesUsed.csPhase3 ? 1 : 0;
        car.minCurrent = car.minCurrentPerPhase * numberOfPhasesInProgress;
        car.maxCurrent = car.maxCurrentPerPhase * numberOfPhasesInProgress;
      }
      // Check if Charging Station is DC
    } else if (Utils.getChargingStationCurrentType(chargingStation, null, transaction.connectorId) === CurrentType.DC
      && transaction.currentInstantWattsDC > 0 && this.setting.stickyLimitation) {
      // Check if car wants to increase its consumption
      const carIsIncreasingConsumption = this.checkIfCarIsIncreasingConsumption(chargingStation, transaction, CurrentType.DC, car);
      if (!carIsIncreasingConsumption) {
        // Get Amps from current DC consumption (Watt)
        const currentInstantAmps = Utils.convertWattToAmp(chargingStation, null, transaction.connectorId, transaction.currentInstantWattsDC);
        // Setting limit to current consumption with buffer (If it goes above the station limit it will be limited by the optimizer fuse tree)
        car.maxCurrentPerPhase = Utils.roundTo((currentInstantAmps / 3 * (1 + (typeof this.setting.limitBufferDC === 'number' ? this.setting.limitBufferDC : 0) / 100)), 3);
        car.maxCurrent = car.maxCurrentPerPhase * 3;
      }
    }
  }

  private connectorIsCharging(connector: Connector): boolean {
    return connector.status === ChargePointStatus.CHARGING ||
      connector.status === ChargePointStatus.SUSPENDED_EV ||
      connector.status === ChargePointStatus.SUSPENDED_EVSE ||
      connector.status === ChargePointStatus.OCCUPIED;
  }

  private getConnectorNbrOfPhasesAndAmps(siteArea: SiteArea, chargingStation: ChargingStation, connector: Connector): ConnectorAmps {
    const connectorAmps: ConnectorAmps = {
      numberOfConnectedPhase: 0,
      totalAmps: 0
    };
    if (connector.chargePointID) {
      const chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
      // Get the usual power
      connectorAmps.numberOfConnectedPhase = Utils.getNumberOfConnectedPhases(chargingStation, chargePoint, connector.connectorId);
      connectorAmps.totalAmps = Utils.getChargingStationAmperage(chargingStation, chargePoint, connector.connectorId);
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
            connectorAmps.totalAmps /= numberOfConnectorsCurrentlyCharging;
          }
          // Already several connectors charging in //
          if (chargePoint.cannotChargeInParallel && numberOfConnectorsCurrentlyCharging > 1) {
            // Annihilate the power of the connector
            connectorAmps.totalAmps = 0;
          }
        }
      }
    } else {
      connectorAmps.numberOfConnectedPhase = connector.numberOfConnectedPhase;
      connectorAmps.totalAmps = connector.amperage;
    }
    if (!connectorAmps.numberOfConnectedPhase) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getConnectorNbrOfPhasesAndAmps',
        message: `${siteArea.name} > Cannot get the number of phases of connector ID '${connector.connectorId}'`,
        detailedMessages: { connector, chargingStation }
      });
    }
    if (!connectorAmps.totalAmps) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.SMART_CHARGING,
        module: MODULE_NAME, method: 'getConnectorNbrOfPhasesAndAmps',
        message: `${siteArea.name} > Cannot get the amperage of connector ID '${connector.connectorId}'`,
        detailedMessages: { connector, chargingStation }
      });
    }
    return connectorAmps;
  }

  private buildChargingStationConnectorFuse(siteArea: SiteArea, fuseID: number, chargingStation: ChargingStation, connector: Connector): OptimizerChargingStationConnectorFuse {
    // Get connector's power
    const connectorAmps = this.getConnectorNbrOfPhasesAndAmps(siteArea, chargingStation, connector);
    let connectorAmpsPerPhase = connectorAmps.totalAmps / connectorAmps.numberOfConnectedPhase;
    // Check if CS is DC and calculate real consumption at the grid
    if (Utils.getChargingStationCurrentType(chargingStation, null, connector.connectorId) === CurrentType.DC) {
      const chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
      if (chargePoint?.efficiency > 0) {
        connectorAmpsPerPhase /= chargePoint.efficiency / 100;
      } else {
        // Use safe value if efficiency is not provided
        connectorAmpsPerPhase /= Constants.DC_CHARGING_STATION_DEFAULT_EFFICIENCY_PERCENT;
      }
    }
    // Build charging station from connector
    const chargingStationConnectorFuse: OptimizerChargingStationConnectorFuse = {
      '@type': 'ChargingStation', // It's connector but for the optimizer this is a Charging Station
      id: fuseID,
      fusePhase1: connectorAmpsPerPhase,
      fusePhase2: (connectorAmps.numberOfConnectedPhase > 1 ? connectorAmpsPerPhase : 0),
      fusePhase3: (connectorAmps.numberOfConnectedPhase > 1 ? connectorAmpsPerPhase : 0),
      phase1Connected: true,
      phase2Connected: (connectorAmps.numberOfConnectedPhase > 1 ? true : false),
      phase3Connected: (connectorAmps.numberOfConnectedPhase > 1 ? true : false),
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
      // Get OCPP Parameter for max periods
      const maxScheduleLength = parseInt(await ChargingStationStorage.getOcppParameterValue(this.tenantID, chargingStationID, 'ChargingScheduleMaxPeriods'));
      // Start from now up to the third slot
      for (let i = Math.floor(currentDurationFromMidnightMins / 15); i < (!isNaN(maxScheduleLength) ?
        (Math.floor(currentDurationFromMidnightMins / 15) + maxScheduleLength) :
        Math.floor(currentDurationFromMidnightMins / 15) + 20) && i < car.currentPlan.length &&
        (car.currentPlan[i] > 0 || chargingSchedule.chargingSchedulePeriod.length < 3); i++) {
        chargingSchedule.chargingSchedulePeriod.push({
          startPeriod: currentTimeSlotMins * 15 * 60, // Start period in secs (starts at 0 sec from startSchedule date/time)
          limit: this.calculateCarConsumption(chargingStation, connector, numberOfConnectedPhase, car.currentPlan[i])
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

  private calculateCarConsumption(chargingStation: ChargingStation, connector: Connector, numberOfConnectedPhase: number, currentLimit: number): number {
    // Calculation of power which the car consumes after the loss of power in the charging station
    if (Utils.getChargingStationCurrentType(chargingStation, null, connector.connectorId) === CurrentType.DC) {
      const chargePoint = Utils.getChargePointFromID(chargingStation, connector.chargePointID);
      if (chargePoint?.efficiency > 0) {
        return Utils.roundTo(currentLimit * chargePoint.efficiency / 100 * numberOfConnectedPhase, 3);
      }
      return Utils.roundTo(currentLimit * Constants.DC_CHARGING_STATION_DEFAULT_EFFICIENCY_PERCENT * numberOfConnectedPhase, 3);
    }
    return Utils.roundTo((currentLimit * numberOfConnectedPhase), 3);
  }

  private checkIfCarIsIncreasingConsumption(chargingStation: ChargingStation, transaction: Transaction, currentType: CurrentType,
    car: OptimizerCar, numberOfPhasesInProgress?: number): boolean {
    // Get the current charging profile for the current car
    const currentProfile = this.currentChargingProfiles.filter((chargingProfile) =>
      chargingProfile.profile.transactionId === transaction.id &&
      chargingProfile.chargingStationID === transaction.chargeBoxID &&
      chargingProfile.connectorID === transaction.connectorId);
    // Check if only one charging profile is in place
    if (currentProfile.length === 1) {
      const currentLimit = this.getCurrentSapSmartChargingProfileLimit(currentProfile[0]);
      // Check if current limit is 0 or if profile is expired --> if yes the car wants to increase consumption
      if (currentLimit < 1) {
        return true;
      }
      const numberOfPhasesChargingStation = Utils.getNumberOfConnectedPhases(chargingStation, null, transaction.connectorId);
      // Check if buffer is used for AC stations
      if (currentType === CurrentType.AC) {
        const currentLimitPerPhase = currentLimit / numberOfPhasesChargingStation;
        // Get amps per phase of the car when the optimizer was called the last time
        let threshold = currentLimitPerPhase / (1 + this.setting.limitBufferAC / 100);
        // Use difference between threshold and last consumption multiplied by 20% to eliminate small fluctuations of the car in the charge
        const normalFluctuation = (currentLimitPerPhase - threshold) * 0.2;
        // Add the normal fluctuation to the threshold
        threshold = threshold + normalFluctuation;
        // Check if threshold is exceeded
        if (threshold < transaction.currentInstantAmps / numberOfPhasesInProgress &&
          currentLimit / numberOfPhasesChargingStation < car.maxCurrentPerPhase) {
          // If yes the car increased its consumption
          return true;
        }
        // Check if buffer is used for DC stations
      } else if (currentType === CurrentType.DC) {
        // Get amps of the car when the optimizer was called the last time
        let threshold = currentLimit / (1 + this.setting.limitBufferDC / 100);
        // Use difference between threshold and last consumption multiplied by 20% to eliminate small fluctuations of the car in the charge
        const normalFluctuation = (currentLimit - threshold) * 0.2;
        // Add the normal fluctuation to the threshold
        threshold = threshold + normalFluctuation;
        if (threshold < Utils.convertWattToAmp(chargingStation, null, transaction.connectorId, transaction.currentInstantWattsDC) && currentLimit < car.maxCurrentPerPhase) {
          // If yes the car increased its consumption
          return true;
        }
      }
    }
    return false;
  }

  private getCurrentSapSmartChargingProfileLimit(currentProfile: ChargingProfile): number {
    // Get the current slot to get the current period of the schedule
    const currentSlot = Math.floor((moment().diff(moment(currentProfile.profile.chargingSchedule.startSchedule), 'minutes')) / 15);
    // Check if charging profile is expired
    if (currentSlot < currentProfile.profile.chargingSchedule.chargingSchedulePeriod.length) {
      // Get current limit and number of phases
      const currentLimit = currentProfile.profile.chargingSchedule.chargingSchedulePeriod[currentSlot]?.limit;
      return currentLimit;
    }
    return -1;
  }
}
