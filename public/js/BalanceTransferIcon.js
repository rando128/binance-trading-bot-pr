/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */

/* eslint-disable no-undef */

class BalanceTransferIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      loading: false,
      balanceTransfer: {},
      accountInfo: {},
      selectedAsset: '',
      amount: '',
      destination: 'master'
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleCheckboxChange = this.handleCheckboxChange.bind(this);
    this.setAmount = this.setAmount.bind(this);
    this.setDestination = this.setDestination.bind(this);
    this.executeBalanceTransfer = this.executeBalanceTransfer.bind(this);
  }

  componentDidUpdate(nextProps) {
    const { balanceTransfer, selectedAsset, amount } = this.state;

    // Update balanceTransfer
    if (
      _.get(nextProps, 'balanceTransfer', null) !== null &&
      _.isEqual(_.get(nextProps, 'balanceTransfer', null), balanceTransfer) ===
        false
    ) {
      this.setState({
        loading: false,
        balanceTransfer: nextProps.balanceTransfer
      });
    }

    // Update selectedAsset
    if (
      _.get(nextProps, 'selectedAsset', null) !== null &&
      _.isEqual(_.get(nextProps, 'selectedAsset', null), selectedAsset) ===
        false
    ) {
      const newSelectedAsset = nextProps.selectedAsset;
      this.setState({ selectedAsset: newSelectedAsset });
    }

    // Update amount
    if (
      _.get(nextProps, 'amount', null) !== null &&
      _.isEqual(_.get(nextProps, 'amount', null), amount) === false
    ) {
      const newAmount = nextProps.amount;
      this.setState({ amount: newAmount });
    }
  }

  handleModalShow() {
    this.setState({
      showModal: true,
      loading: true,
      balanceTransfer: {},
      accountInfo: {},
      selectedAsset: '',
      amount: '',
      selectedDestination: 'master'
    });

    this.props.sendWebSocket('balances-get', {});
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });
  }

  handleCheckboxChange(event) {
    const assetKey = event.target.getAttribute('data-state-asset');

    this.setState({
      selectedAsset: assetKey
    });
  }

  setAmount(event) {
    const value = event.target.value;

    this.setState({
      amount: value
    });
  }

  setDestination(event) {
    const value = event.target.value;

    this.setState({
      destination: value
    });
  }

  isValidFloat(value) {
    return !isNaN(value) && value.trim() !== '' && parseFloat(value) > 0;
  }

  executeBalanceTransfer() {
    const { selectedAsset, amount, destination } = this.state;

    const [fromEmail, asset, freeAmount] = selectedAsset.split('-');

    console.log(fromEmail, asset, freeAmount);
    console.log(amount);
    if (destination === fromEmail) {
      console.log("Can't transfer to the same account");
      return;
    }

    if (parseFloat(amount) > parseFloat(freeAmount)) {
      console.log('Amount is greater than the available balance');
      return;
    }

    const balanceTransfer = {
      asset,
      amount: parseFloat(amount)
    };

    if (destination !== 'master') {
      balanceTransfer.toEmail = destination;
    }
    if (fromEmail !== 'master') {
      balanceTransfer.fromEmail = fromEmail;
    }

    this.handleModalClose();
    this.props.sendWebSocket('balance-transfer-execute', {
      balanceTransfer
    });
  }

  render() {
    const { isAuthenticated } = this.props;
    const { showModal, loading, balanceTransfer, destination, amount } =
      this.state;

    const mapping = {
      //'nmoralesparga@gmail.com': 'COL',
      master: 'EU',
      'shonore.binancesa4@gmail.com': 'EU1',
      'shonore.binancesa1@gmail.com': 'EU2',
      'shonore.binancesa2@gmail.com': 'B1',
      'shonore.binancesa3@gmail.com': 'B2'
    };

    if (isAuthenticated === false) {
      return '';
    }

    let accounts = null;
    if (_.isEmpty(balanceTransfer) === false) {
      // Sort function based on the custom order
      const sortOrder = Object.keys(mapping);
      const sortedBalances = JSON.parse(JSON.stringify(balanceTransfer)).sort(
        (a, b) => {
          return sortOrder.indexOf(a.email) - sortOrder.indexOf(b.email);
        }
      );
      accounts = sortedBalances.map((account, index) => (
        <div key={`account-${index}`} className='col-xs-12 col-sm-6'>
          <div className='mt-1 card'>
            <div className='px-2 py-1 card-header'>
              {mapping[account.email]}
            </div>
            <div key={`account-${index}`} className='px-2 py-1 card-body'>
              {account.balance.map(s => (
                <Form.Check
                  key={`symbol-${account.email}-${s.asset}`}
                  type='checkbox'
                  id={`symbol-${account.email}-${s.asset}`}
                  label={`${s.asset}: ${s.free}`}
                  checked={
                    this.state.selectedAsset ===
                    `${account.email}-${s.asset}-${s.free}`
                  }
                  data-state-asset={`${account.email}-${s.asset}-${s.free}`}
                  onChange={this.handleCheckboxChange}
                  className='checkbox-dust-transfer-symbol w-90'
                />
              ))}
            </div>
          </div>
        </div>
      ));
    }

    return (
      <div className='dust-transfer-wrapper'>
        <div className='dust-transfer-column'>
          <button
            type='button'
            className='btn btn-sm btn-link btn-dust-transfer'
            onClick={() => this.handleModalShow()}>
            Transfer assets
          </button>
        </div>
        <Modal
          show={showModal}
          onHide={() => this.handleModalClose()}
          backdrop='static'
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Transfer balances across accounts</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className='d-block text-muted mb-2'>
              Available balances across sub-accounts.
            </p>
            <div className='dust-transfer-symbols-parent-wrappers'>
              {loading ? (
                <div className='text-center w-100'>
                  <Spinner animation='border' role='status'>
                    <span className='sr-only'>Loading...</span>
                  </Spinner>
                </div>
              ) : (
                <div className='dust-transfer-symbols-wrappers'>
                  {_.isEmpty(accounts) ? (
                    <div className='text-center'>
                      Assets can't be transferred from this sub-account.
                    </div>
                  ) : (
                    <React.Fragment>
                      <div className='accordion mb-2'>
                        <div className='row'>{accounts}</div>
                      </div>
                      <div className='row'>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group className='mb-2'>
                            <Form.Label className='mb-2 '>
                              <strong>Amount:</strong>{' '}
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='search'
                              placeholder='Enter amount...'
                              onChange={this.setAmount}
                            />
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group className='mb-2'>
                            <Form.Label className='mb-2 '>
                              <strong>Destination:</strong>{' '}
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              as='select'
                              required
                              data-state-key='destination'
                              value={destination}
                              onChange={this.setDestination}>
                              {/* Generate options dynamically from the mapping */}
                              {Object.entries(mapping).map(([key, value]) => (
                                <option key={key} value={key}>
                                  {value}
                                </option>
                              ))}
                            </Form.Control>
                          </Form.Group>
                        </div>
                      </div>
                      <div className='dust-transfer-button-wrapper'>
                        <button
                          type='button'
                          className='btn btn-sm btn-primary w-100 btn-dust-transfer-execute'
                          onClick={() => this.executeBalanceTransfer()}
                          disabled={!this.isValidFloat(amount)}>
                          Transfer
                        </button>
                      </div>
                    </React.Fragment>
                  )}
                </div>
              )}
            </div>
          </Modal.Body>
        </Modal>
      </div>
    );
  }
}
